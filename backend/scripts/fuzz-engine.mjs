import { loadSeedBoard } from './seedBoard.mjs';
import { createGameState, createPlayerGameState, GAME_PHASES } from '../src/domain/gameState.js';
import { createProperty } from '../src/domain/property.js';
import { transitionTurn, getCurrentPlayer } from '../src/stateMachine/turnMachine.js';
import { serverGeneratedFields } from '../src/infrastructure/websocket/socketServer.js';
import { buildDefaultAction } from '../src/stateMachine/timers.js';
import { verifyEconomyInvariant } from '../src/economy/assertInvariant.js';
import { EVENT_CARDS } from '../src/domain/eventDictionary.js';
import crypto from 'node:crypto';

const STARTING_BALANCE = 1500;
const BANK_RESERVE_INITIAL = 20000;
const BUYABLE = ['property', 'transport', 'utility'];
const DOMAIN_ERRS = new Set([
  'InvalidTurnActionError', 'InvalidPropertyActionError', 'InvalidInventoryActionError',
  'InvalidJailActionError', 'InvalidForfeitError', 'InvalidBidError',
  'EventChoiceError', 'InvalidTradeError', 'InvalidMovementCardError',
  'InvalidDraftActionError', 'InvalidTrapActionError',
]);

function mkGame(ruleset, nPlayers, board) {
  const bank = createPlayerGameState({
    id: 'bank', gameId: 'g', isBank: true,
    currentBalance: BANK_RESERVE_INITIAL - nPlayers * STARTING_BALANCE,
  });
  const players = Array.from({ length: nPlayers }, (_, i) =>
    createPlayerGameState({
      id: 'p' + i, gameId: 'g', playerId: 'u' + i, turnOrder: i,
      currentBalance: STARTING_BALANCE, currentPosition: 0, zodiac: 'ty',
    }));
  const properties = board
    .filter((t) => BUYABLE.includes(t.tileType))
    .map((t) => createProperty({ id: 'pr-' + t.id, gameId: 'g', boardTileId: t.id }));
  return createGameState({
    id: 'g', roomId: 'r', boardId: 'small', ruleset, status: 'in_progress',
    phase: 'TURN_START', currentTurnIndex: 0, players: [bank, ...players],
    properties, eventDeck: Object.keys(EVENT_CARDS).slice(),
  });
}

const PHASE_ACTIONS = {
  TURN_START: ['START_TURN'],
  ROLLING: ['ROLL_DICE'],
  PLAYING_CARD: ['PLAY_MOVEMENT_CARD'],
  JAIL_DECISION: ['PAY_JAIL_FINE', 'USE_JAIL_CARD', 'ATTEMPT_JAIL_ROLL'],
  AWAITING_PURCHASE: ['BUY_PROPERTY', 'SKIP_PURCHASE', 'FORCE_AUCTION'],
  AWAITING_UPGRADE: ['BUILD_HOUSE', 'DECLINE_UPGRADE'],
  FLASH_AUCTION_ACTIVE: ['PLACE_BID', 'FOLD_AUCTION', 'AUCTION_TIMEOUT'],
  AWAITING_EVENT_CHOICE: ['MAKE_EVENT_CHOICE'],
  POST_ACTIONS: ['END_TURN', 'BUILD_HOUSE', 'SELL_HOUSE', 'MORTGAGE', 'UNMORTGAGE', 'HOSTILE_BUYOUT', 'DECLINE_HOSTILE_BUYOUT', 'FORCE_AUCTION'],
  LIQUIDATION_REQUIRED: ['SELL_HOUSE', 'MORTGAGE'],
  HOSTILE_ACQUISITION_PENDING: ['HOSTILE_BUYOUT', 'DECLINE_HOSTILE_BUYOUT'],
};

function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
}

function buildPayload(type, gs, rnd) {
  const me = getCurrentPlayer(gs);
  const mine = gs.properties.filter((p) => p.ownerId === me?.id);
  const theirs = gs.properties.filter((p) => p.ownerId && p.ownerId !== me?.id);
  switch (type) {
    case 'PLAY_MOVEMENT_CARD':
      return { cardId: pick(me?.movementHand?.length ? me.movementHand : ['MOVE_5'], rnd) };
    case 'BUILD_HOUSE': case 'MORTGAGE': case 'SELL_HOUSE': case 'UNMORTGAGE':
      return { propertyId: (mine.length ? pick(mine, rnd) : pick(gs.properties, rnd)).id };
    case 'HOSTILE_BUYOUT':
      return { propertyId: (theirs.length ? pick(theirs, rnd) : pick(gs.properties, rnd)).id };
    case 'FORCE_AUCTION':
      return { basePrice: 1 + Math.floor(rnd() * 400) };
    case 'PLACE_BID':
      return { amount: (gs.pendingAuction?.currentBid ?? 0) + 1 + Math.floor(rnd() * 60) };
    case 'MAKE_EVENT_CHOICE': {
      const opts = EVENT_CARDS[gs.pendingEventCardId]?.options ?? [];
      return {
        optionId: opts.length ? pick(opts, rnd).id : 'OPT_SAFE',
        propertyId: mine.length ? pick(mine, rnd).id : undefined,
      };
    }
    case 'USE_INVENTORY_CARD':
      return { cardId: pick(me?.inventory?.length ? me.inventory : ['C12_CO_HOI_CUOI'], rnd) };
    default:
      return {};
  }
}

function fuzz(ruleset, nPlayers, steps, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const board = loadSeedBoard('small');
  let gs = mkGame(ruleset, nPlayers, board);
  const out = { steps: 0, games: 1, defaultFail: [], invariantFail: [], crashes: [], badPhase: [] };

  for (let i = 0; i < steps; i++) {
    if (gs.status !== 'in_progress') { gs = mkGame(ruleset, nPlayers, board); out.games++; continue; }
    if (!GAME_PHASES.includes(gs.phase)) { out.badPhase.push(String(gs.phase)); break; }

    // INVARIANT 1: the turn-timer safety net must be buildable for the live phase.
    try {
      buildDefaultAction(gs.phase, gs, board, rnd);
    } catch (err) {
      const key = gs.phase + ' -> ' + err.constructor.name + ': ' + err.message;
      if (!out.defaultFail.some((f) => f.startsWith(gs.phase + ' ->'))) out.defaultFail.push(key);
    }

    const pool = PHASE_ACTIONS[gs.phase] ?? ['END_TURN'];
    let type = pick(pool, rnd);
    if (rnd() < 0.04) type = 'FORFEIT_MATCH';
    if (rnd() < 0.06 && getCurrentPlayer(gs)?.inventory?.length) type = 'USE_INVENTORY_CARD';

    const bidders = gs.pendingAuction?.activeBidders;
    const actor = ['PLACE_BID', 'FOLD_AUCTION'].includes(type) && bidders?.length
      ? pick(bidders, rnd)
      : getCurrentPlayer(gs)?.id;
    if (!actor) { gs = mkGame(ruleset, nPlayers, board); out.games++; continue; }

    const now = new Date(Date.now() + i * 1000).toISOString();
    let payload;
    try {
      const base = buildPayload(type, gs, rnd);
      payload = { ...base, playerId: actor, ...serverGeneratedFields(type, gs, base, rnd) };
    } catch (err) {
      const key = 'serverGeneratedFields(' + type + ') -> ' + err.constructor.name + ': ' + err.message;
      if (!out.crashes.includes(key)) out.crashes.push(key);
      continue;
    }

    const before = gs;
    try {
      gs = transitionTurn(gs, board, { type, payload, clientActionId: crypto.randomUUID() }, now).gameState;
      out.steps++;
    } catch (err) {
      if (!DOMAIN_ERRS.has(err.constructor.name)) {
        const key = before.phase + ' + ' + type + ' -> ' + err.constructor.name + ': ' + err.message;
        if (!out.crashes.includes(key)) out.crashes.push(key);
      }
      continue;
    }

    // INVARIANT 2: closed economy.
    try {
      verifyEconomyInvariant(gs, BANK_RESERVE_INITIAL);
    } catch (err) {
      const key = before.phase + ' + ' + type + ': ' + err.message;
      if (out.invariantFail.length < 8 && !out.invariantFail.includes(key)) out.invariantFail.push(key);
      gs = mkGame(ruleset, nPlayers, board); out.games++;
    }
  }
  return out;
}

const SEEDS = Number(process.env.SEEDS ?? 30);
const STEPS = Number(process.env.STEPS ?? 4000);

for (const ruleset of ['CLASSIC', 'ASYMMETRIC']) {
  for (const n of [2, 4]) {
    const agg = { steps: 0, games: 0, defaultFail: new Set(), invariantFail: new Set(), crashes: new Set(), badPhase: new Set() };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = fuzz(ruleset, n, STEPS, seed * 7919);
      agg.steps += r.steps; agg.games += r.games;
      r.defaultFail.forEach((x) => agg.defaultFail.add(x));
      r.invariantFail.forEach((x) => agg.invariantFail.add(x));
      r.crashes.forEach((x) => agg.crashes.add(x));
      r.badPhase.forEach((x) => agg.badPhase.add(x));
    }
    console.log('\n===== ' + ruleset + ' / ' + n + ' players — ' + agg.steps + ' applied steps, ' + agg.games + ' games =====');
    const show = (label, set) => {
      console.log(label + ': ' + set.size);
      [...set].slice(0, 6).forEach((x) => console.log('   * ' + x));
    };
    show('timeout-default failures', agg.defaultFail);
    show('economy invariant violations', agg.invariantFail);
    show('non-domain crashes', agg.crashes);
    show('invalid phases', agg.badPhase);
  }
}
