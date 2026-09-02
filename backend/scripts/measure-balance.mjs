// THROWAWAY balance-measurement harness — delete after use.
//
// Drives the REAL engine (transitionTurn + tradeMachine) with a "reasonable
// player" bot over the REAL small board seed, and reports the metrics the
// 2026-09-01 design review left open:
//   - snowball: does the round-10 net-worth leader win?
//   - is Monopoly a dead strategic goal? (the headline question)
//   - Free Parking jackpot distribution, especially the TAIL
//   - jail occupancy by game phase (baseline before the jail change)
//   - game length / how matches actually end / house scarcity
//
// Deliberately NOT a monopoly-seeking bot: it buys what it lands on, builds
// where profitable, and trades when a trade is good for it. If monopolies
// form, they form the way they would in a real match. Rigging the bot to
// chase monopolies would answer the headline question by assumption.
import { transitionTurn, InvalidTurnActionError, InvalidPropertyActionError, InvalidInventoryActionError, InvalidForfeitError } from '../src/stateMachine/turnMachine.js';
import { applyTradeAction, TRADE_ACTION_TYPES } from '../src/stateMachine/tradeMachine.js';
import { InvalidTradeError } from '../src/engine/trade.js';
import { EventChoiceError } from '../src/engine/eventResolver.js';
import { InvalidBidError } from '../src/engine/auction.js';
import { createTile } from '../src/domain/tile.js';
import { createProperty } from '../src/domain/property.js';
import { createGameState, createPlayerGameState } from '../src/domain/gameState.js';
import { netWorth } from '../src/engine/netWorth.js';
import { calculateRent } from '../src/engine/calculateRent.js';
import { EVENT_CARDS } from '../src/domain/eventDictionary.js';

const EXPECTED = [InvalidTurnActionError, InvalidPropertyActionError, InvalidInventoryActionError, InvalidForfeitError, EventChoiceError, InvalidBidError, InvalidTradeError];
const isExpected = (e) => EXPECTED.some((C) => e instanceof C);

let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];

// ── The REAL small board (backend/supabase/seed/boards.sql, applied live) ──
const SEED = [
  [0, 'go'], [1, 'property', 'red', 60, 2, [10, 30, 90, 160, 250], 50, 30], [2, 'fortune'],
  [3, 'property', 'red', 60, 4, [20, 60, 180, 320, 450], 50, 30], [4, 'tax', null, null, null, null, null, null, 200],
  [5, 'property', 'cyan', 100, 6, [30, 90, 270, 400, 550], 50, 50], [6, 'chance'],
  [7, 'property', 'cyan', 100, 6, [30, 90, 270, 400, 550], 50, 50],
  [8, 'property', 'cyan', 120, 8, [40, 100, 300, 450, 600], 50, 60], [9, 'jail'],
  [10, 'property', 'purple', 140, 10, [50, 150, 450, 625, 750], 100, 70],
  [11, 'utility', null, 200, null, null, null, 75],
  [12, 'property', 'purple', 140, 10, [50, 150, 450, 625, 750], 100, 70],
  [13, 'property', 'purple', 160, 12, [60, 180, 500, 700, 900], 100, 80],
  [14, 'transport', null, 200, 25, null, null, 100],
  [15, 'property', 'orange', 180, 14, [70, 200, 550, 750, 950], 100, 90],
  [16, 'property', 'orange', 180, 14, [70, 200, 550, 750, 950], 100, 90],
  [17, 'property', 'orange', 200, 16, [80, 220, 600, 800, 1000], 100, 100], [18, 'free_parking'],
  [19, 'property', 'yellow', 220, 18, [90, 250, 700, 875, 1050], 150, 110], [20, 'chance'],
  [21, 'property', 'yellow', 220, 18, [90, 250, 700, 875, 1050], 150, 110],
  [22, 'property', 'yellow', 240, 20, [100, 300, 750, 925, 1100], 150, 120],
  [23, 'property', 'green', 260, 22, [110, 330, 800, 975, 1150], 100, 70],
  [24, 'property', 'green', 260, 22, [110, 330, 800, 975, 1150], 100, 70],
  [25, 'utility', null, 200, null, null, null, 75],
  [26, 'property', 'green', 280, 24, [120, 360, 850, 1025, 1200], 100, 80], [27, 'go_to_jail'],
  [28, 'property', 'blue', 300, 26, [130, 390, 900, 1100, 1275], 200, 150],
  [29, 'property', 'blue', 300, 26, [130, 390, 900, 1100, 1275], 200, 150], [30, 'fortune'],
  [31, 'property', 'blue', 320, 28, [150, 450, 1000, 1200, 1400], 200, 160],
  [32, 'transport', null, 200, 25, null, null, 100],
  [33, 'property', 'darkblue', 350, 35, [175, 500, 1100, 1300, 1500], 200, 175],
  [34, 'tax', null, null, null, null, null, null, 100],
  [35, 'property', 'darkblue', 400, 50, [200, 600, 1400, 1700, 2000], 200, 200],
];
const board = SEED.map(([position, tileType, groupId, price, baseRent, rentTable, houseCost, mortgageValue, taxAmount]) =>
  createTile({
    id: `t${position}`, boardId: 'small', position, tileType, name: `T${position}`,
    ...(groupId ? { groupId } : {}), ...(price != null ? { price } : {}),
    ...(baseRent != null ? { baseRent } : {}), ...(rentTable ? { rentTable } : {}),
    ...(houseCost != null ? { houseCost } : {}), ...(mortgageValue != null ? { mortgageValue } : {}),
    ...(taxAmount != null ? { taxAmount } : {}),
  })
);
const BUYABLE = new Set(['property', 'transport', 'utility']);
const tileById = new Map(board.map((t) => [t.id, t]));
const GROUP_SIZE = board.reduce((m, t) => (t.groupId ? m.set(t.groupId, (m.get(t.groupId) ?? 0) + 1) : m), new Map());

function initial(n) {
  const players = [createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 })];
  for (let i = 0; i < n; i++) players.push(createPlayerGameState({ id: `gp-${i}`, gameId: 'g1', playerId: `u${i}`, turnOrder: i, currentBalance: 1500, currentPosition: 0 }));
  const properties = board.filter((t) => BUYABLE.has(t.tileType)).map((t) => createProperty({ id: `p-${t.position}`, gameId: 'g1', boardTileId: t.id }));
  const deck = Object.keys(EVENT_CARDS);
  for (let i = deck.length - 1; i > 0; i--) { const j = int(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return createGameState({ id: 'g1', roomId: 'r1', boardId: 'small', status: 'in_progress', phase: 'TURN_START', currentTurnIndex: 0, players, properties, eventDeck: deck, startedAt: '2026-09-01T00:00:00.000Z' });
}

const cur = (gs) => gs.players.find((p) => !p.isBank && p.turnOrder === gs.currentTurnIndex);
const alive = (gs) => gs.players.filter((p) => !p.isBank && !p.bankrupt);
const myProps = (gs, id) => gs.properties.filter((p) => p.ownerId === id);

/** Groups this player owns COMPLETELY (a real monopoly). */
function monopoliesOf(gs, playerId) {
  const owned = new Map();
  for (const p of gs.properties) {
    if (p.ownerId !== playerId) continue;
    const g = tileById.get(p.boardTileId)?.groupId;
    if (g) owned.set(g, (owned.get(g) ?? 0) + 1);
  }
  return [...owned.entries()].filter(([g, n]) => n === GROUP_SIZE.get(g)).map(([g]) => g);
}
const hasMonopolyOn = (gs, playerId, tile) => tile.groupId != null && monopoliesOf(gs, playerId).includes(tile.groupId);

// ── The bot: a plausible, non-monopoly-obsessed decent player ──
const RESERVE = 250; // keeps a liquidity buffer rather than spending to zero

function chooseAction(gs, M) {
  const me = cur(gs);
  if (!me) return null;
  const mine = myProps(gs, me.id);

  switch (gs.phase) {
    case 'TURN_START': return { type: 'START_TURN' };
    case 'ROLLING': {
      const a = 1 + int(6), b = 1 + int(6);
      return { type: 'ROLL_DICE', payload: { die1: a, die2: b, total: a + b, isDouble: a === b, doublesStreak: a === b ? 1 : 0, sentToJail: false } };
    }
    case 'JAIL_DECISION': {
      M.jailTurns[gs.roundNumber >= 20 ? 'late' : 'early']++;
      // Current rules deny ALL economy while jailed, so leaving ASAP is
      // correct play — this is the baseline the jail change is meant to alter.
      // After the 2026-09-01 revision a jailed player keeps their economy, so
      // buying out early is no longer automatically right — the bot now pays
      // only when cash-rich, and otherwise rolls (and uses the jail turn).
      if (me.currentBalance > 900) return { type: 'PAY_JAIL_FINE' };
      const a = 1 + int(6), b = 1 + int(6);
      return { type: 'ATTEMPT_JAIL_ROLL', payload: { die1: a, die2: b, total: a + b, isDouble: a === b, doublesStreak: 0, sentToJail: false } };
    }
    case 'AWAITING_PURCHASE': {
      const tile = board.find((t) => t.position === me.currentPosition);
      if (!tile) return { type: 'SKIP_PURCHASE' };
      if (me.currentBalance - tile.price >= RESERVE) return { type: 'BUY_PROPERTY' };
      // Auction V2 (2026-09-01): declining is now a real two-way choice.
      // SKIP is free and leaves the land unowned; FORCE_AUCTION costs a fee
      // (5% of base, clamped [20,80]) and pays the initiator 20% of the
      // winning bid back as broker commission. A player who cannot afford the
      // property but can afford the fee has a genuine reason to force the
      // sale — modelled here so the measurement exercises both branches
      // rather than only the free one.
      const fee = Math.min(80, Math.max(20, Math.ceil(tile.price * 0.05)));
      if (me.currentBalance - fee >= RESERVE && rnd() < 0.45) return { type: 'FORCE_AUCTION' };
      return { type: 'SKIP_PURCHASE' };
    }
    case 'AWAITING_UPGRADE': {
      const tile = board.find((t) => t.position === me.currentPosition);
      const prop = gs.properties.find((p) => p.boardTileId === tile?.id);
      if (prop && tile?.tileType === 'property' && me.currentBalance - tile.houseCost >= RESERVE) {
        return { type: 'BUILD_HOUSE', payload: { propertyId: prop.id } };
      }
      return { type: 'DECLINE_UPGRADE' };
    }
    case 'FLASH_AUCTION_ACTIVE': {
      const a = gs.activeAuction ?? gs.pendingAuction;
      if (!a) return { type: 'AUCTION_TIMEOUT' };
      const tile = tileById.get(gs.properties.find((p) => p.id === a.propertyId)?.boardTileId);
      const worth = Math.floor((tile?.price ?? 100) * 0.85);
      const bidder = pick(a.activeBidders ?? []);
      if (!bidder) return { type: 'AUCTION_TIMEOUT' };
      const bp = gs.players.find((p) => p.id === bidder);
      const next = (a.currentBid ?? 0) + 10;
      if (next <= worth && bp && bp.currentBalance - next >= RESERVE) return { type: 'PLACE_BID', payload: { playerId: bidder, amount: next } };
      return { type: 'FOLD_AUCTION', payload: { playerId: bidder } };
    }
    case 'AWAITING_EVENT_CHOICE': {
      const card = EVENT_CARDS[gs.pendingEventCardId];
      const opts = card?.options ?? [];
      if (!opts.length) return { type: 'MAKE_EVENT_CHOICE', payload: { optionId: 'X' } };
      const o = pick(opts);
      // Stands in for socketServer.js's serverGeneratedFields() — in the real
      // system the server injects these, never the client.
      const payload = { optionId: o.id, probabilityRoll: rnd(), dieFaceRoll: 1 + int(6) };
      if ((o.intents ?? []).some((i) => i.action === 'GRANT_PROPERTY_PROTECTION')) {
        const e = mine.filter((p) => p.upgradeLevel === 0);
        if (e.length) payload.propertyId = pick(e).id;
      }
      return { type: 'MAKE_EVENT_CHOICE', payload };
    }
    case 'LIQUIDATION_REQUIRED': {
      const built = mine.filter((p) => p.upgradeLevel > 0);
      if (built.length) return { type: 'SELL_HOUSE', payload: { propertyId: pick(built).id } };
      const un = mine.filter((p) => !p.mortgaged);
      if (un.length) return { type: 'MORTGAGE', payload: { propertyId: pick(un).id } };
      return { type: 'FORFEIT_MATCH', payload: { playerId: me.id } };
    }
    case 'POST_ACTIONS': {
      if (gs.pendingHostileBuyoutPropertyId && me.currentBalance > 900 && rnd() < 0.5) {
        M.buyoutAttempts++;
        return { type: 'HOSTILE_BUYOUT' };
      }
      // Build where it pays: unimproved-first, cheapest house cost, keeping reserve.
      const buildable = mine
        .filter((p) => !p.mortgaged && p.upgradeLevel < 5 && tileById.get(p.boardTileId)?.tileType === 'property')
        .sort((a, b) => a.upgradeLevel - b.upgradeLevel);
      for (const p of buildable) {
        const tile = tileById.get(p.boardTileId);
        if (me.currentBalance - tile.houseCost >= RESERVE + 200 && rnd() < 0.6) {
          return { type: 'BUILD_HOUSE', payload: { propertyId: p.id } };
        }
      }
      if (me.currentBalance < 120) {
        const un = mine.filter((p) => !p.mortgaged && p.upgradeLevel === 0);
        if (un.length) return { type: 'MORTGAGE', payload: { propertyId: pick(un).id } };
      }
      return { type: 'END_TURN' };
    }
    default: return null;
  }
}

// A trade a decent player would actually make: it completes (or extends) a
// group for the proposer and pays the target a real premium for it.
function maybeTrade(gs) {
  const live = alive(gs);
  if (live.length < 2 || rnd() > 0.25) return null;
  const me = pick(live);
  const mineIds = new Set(myProps(gs, me.id).map((p) => p.boardTileId));
  const wantGroups = new Map();
  for (const p of gs.properties) {
    const t = tileById.get(p.boardTileId);
    if (!t?.groupId || p.ownerId === me.id || !p.ownerId) continue;
    const held = [...mineIds].filter((id) => tileById.get(id)?.groupId === t.groupId).length;
    if (held === GROUP_SIZE.get(t.groupId) - 1) wantGroups.set(p.id, p.ownerId); // one lô away from a monopoly
  }
  if (!wantGroups.size) return null;
  const [propId, ownerId] = pick([...wantGroups.entries()]);
  const tile = tileById.get(gs.properties.find((p) => p.id === propId).boardTileId);
  const offer = Math.floor(tile.price * 1.4);
  if (me.currentBalance - offer < RESERVE) return null;
  return {
    type: 'PROPOSE_TRADE',
    payload: { playerId: me.id, targetId: ownerId, tradeId: `tr-${int(1e9)}`,
      proposerOffer: { properties: [], money: offer }, targetOffer: { properties: [propId], money: 0 } },
  };
}

function respondToTrades(gs, skip) {
  for (const t of gs.pendingTrades ?? []) {
    if (skip.has(t.id)) continue; // a trade whose response already errored — don't retry it forever (real infinite loop, first run)
    const target = gs.players.find((p) => p.id === t.targetId);
    if (!target || target.bankrupt) continue;
    const gain = t.proposerOffer.money;
    const giveTiles = t.targetOffer.properties.map((id) => tileById.get(gs.properties.find((p) => p.id === id)?.boardTileId));
    const give = giveTiles.reduce((s, x) => s + (x?.price ?? 0), 0);
    // Accepts a clear premium; refuses a lowball. A real player would also
    // weigh "does this hand them a monopoly" — modelled as a reluctance.
    const handsMonopoly = giveTiles.some((x) => x?.groupId);
    const threshold = handsMonopoly ? give * 1.35 : give * 1.05;
    return { type: gain >= threshold ? 'ACCEPT_TRADE' : 'REJECT_TRADE', payload: { playerId: t.targetId, tradeId: t.id } };
  }
  return null;
}

function runGame(numPlayers) {
  let gs = initial(numPlayers);
  const M = {
    builds: { total: 0, withMonopoly: 0 }, jailTurns: { early: 0, late: 0 },
    jackpots: [], monopolyEverBy: new Set(), buyoutAttempts: 0, minHouseSupply: 32, rentFromBonus: 0,
    leaderAtRound10: null, rentPaid: 0,
  };
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  let steps = 0;
  const skipTrades = new Set();
  const upgradeTotal = (s) => s.properties.reduce((n, p) => n + p.upgradeLevel, 0);

  while (gs.status === 'in_progress' && steps < 20000) {
    steps++;
    clock += 15000;
    const now = new Date(clock).toISOString();

    if (M.leaderAtRound10 === null && gs.roundNumber >= 10) {
      const ranked = alive(gs).map((p) => ({ id: p.id, nw: netWorth(gs, board, p.id) })).sort((a, b) => b.nw - a.nw);
      M.leaderAtRound10 = ranked[0]?.id ?? null;
    }
    for (const g of GROUP_SIZE.keys()) {
      for (const p of alive(gs)) if (monopoliesOf(gs, p.id).includes(g)) M.monopolyEverBy.add(`${p.id}:${g}`);
    }
    M.minHouseSupply = Math.min(M.minHouseSupply, gs.houseSupply);

    const action = respondToTrades(gs, skipTrades) ?? maybeTrade(gs) ?? chooseAction(gs, M);
    if (!action) break;

    const before = gs;
    const buildTile = action.type === 'BUILD_HOUSE'
      ? tileById.get(gs.properties.find((p) => p.id === action.payload.propertyId)?.boardTileId)
      : null;
    const builderId = buildTile ? cur(gs)?.id : null;
    const hadMonopoly = buildTile && builderId ? hasMonopolyOn(gs, builderId, buildTile) : false;

    try {
      const res = TRADE_ACTION_TYPES.includes(action.type) ? applyTradeAction(gs, action, now) : transitionTurn(gs, board, action, now);
      gs = res.gameState;
      for (const tx of res.transactions ?? []) {
        if (tx.transactionType === 'free_parking_jackpot') M.jackpots.push(tx.amount);
        if (tx.transactionType !== 'rent') continue;
        M.rentPaid += tx.amount;
        // How much of this rent is ATTRIBUTABLE to the group bonus? Recompute
        // the same rent with group data withheld (hasGroupBonus then returns
        // false) and take the difference. This is the causal question the
        // "monopoly holders win more" correlation cannot answer: owning a
        // whole group means owning lots of property, which wins on its own.
        const payer = gs.players.find((p) => p.id === tx.fromGamePlayerId);
        const tile = payer ? board.find((t) => t.position === payer.currentPosition) : null;
        const prop = tile ? gs.properties.find((p) => p.boardTileId === tile.id) : null;
        if (!prop?.ownerId) continue;
        const holdings = gs.properties.filter((p) => p.ownerId === prop.ownerId).map((p) => ({ tile: tileById.get(p.boardTileId), property: p }));
        const groupTiles = board.filter((t) => t.groupId && t.groupId === tile.groupId);
        try {
          const withBonus = calculateRent({ targetTile: tile, targetProperty: prop, ownerHoldings: holdings, groupTiles, diceRoll: 7 });
          const without = calculateRent({ targetTile: tile, targetProperty: prop, ownerHoldings: holdings, groupTiles: [], diceRoll: 7 });
          M.rentFromBonus += Math.max(0, withBonus - without);
        } catch { /* utility/transport shapes without dice context — not group-bonus tiles anyway */ }
      }
      // Count a build only when one ACTUALLY happened — counting attempts
      // inflated this ~25000x on the first run (every rejected even-build /
      // supply / RECENTLY_ACQUIRED retry was scored as a build).
      if (buildTile && upgradeTotal(gs) > upgradeTotal(before)) {
        M.builds.total++;
        if (hadMonopoly) M.builds.withMonopoly++;
      }
    } catch (e) {
      if (!isExpected(e)) throw e;
      if (TRADE_ACTION_TYPES.includes(action.type)) { skipTrades.add(action.payload.tradeId ?? action.payload.newTradeId ?? 'x'); continue; }
      // A rejected turn action must still make progress or the match stalls.
      if (gs.phase === 'POST_ACTIONS') { try { gs = transitionTurn(gs, board, { type: 'END_TURN' }, now).gameState; continue; } catch { break; } }
      if (gs.phase === 'AWAITING_UPGRADE') { try { gs = transitionTurn(gs, board, { type: 'DECLINE_UPGRADE' }, now).gameState; continue; } catch { break; } }
      // LIQUIDATION_REQUIRED: the bot's naive sell/mortgage pick can violate
      // the even-sell rule and be refused. The REAL game never stalls here —
      // timers.js's 45s buildDefaultAction picks a genuinely valid target —
      // but this bot isn't that smart, so it concedes rather than abandoning
      // the match. Without this, 12/30 games were silently dropped mid-run
      // and the whole sample was biased toward short games.
      if (gs.phase === 'LIQUIDATION_REQUIRED') {
        const debtor = cur(gs);
        try { gs = transitionTurn(gs, board, { type: 'FORFEIT_MATCH', payload: { playerId: debtor.id } }, now).gameState; continue; } catch { break; }
      }
      break;
    }
  }

  const ranked = gs.players.filter((p) => !p.isBank).slice().sort((a, b) => (a.finalRank ?? 99) - (b.finalRank ?? 99));
  const winner = ranked[0]?.id ?? null;
  // Does completing a monopoly actually pay? The direct test: compare the win
  // rate of players who ever held one against players who never did, inside
  // the same matches. Added 2026-09-02 for the group-bonus revision.
  const everHadMonopoly = new Set([...M.monopolyEverBy].map((k) => k.split(':')[0]));
  const realPlayers = gs.players.filter((p) => !p.isBank);
  return {
    winner, leaderAtRound10: M.leaderAtRound10, leaderWon: M.leaderAtRound10 != null && M.leaderAtRound10 === winner,
    rounds: gs.roundNumber, endReason: gs.endReason ?? (gs.status === 'in_progress' ? 'unfinished' : 'unknown'),
    builds: M.builds, jailTurns: M.jailTurns, jackpots: M.jackpots,
    monopoliesFormed: M.monopolyEverBy.size, minHouseSupply: M.minHouseSupply,
    buyoutAttempts: M.buyoutAttempts, rentPaid: M.rentPaid, rentFromBonus: M.rentFromBonus, finished: gs.status !== 'in_progress',
    stuckPhase: gs.status === 'in_progress' ? gs.phase : null, steps,
    stuckAlive: gs.status === 'in_progress' ? alive(gs).length : null,
    monoPlayers: realPlayers.filter((p) => everHadMonopoly.has(p.id)).length,
    nonMonoPlayers: realPlayers.filter((p) => !everHadMonopoly.has(p.id)).length,
    winnerHadMonopoly: winner != null && everHadMonopoly.has(winner),
  };
}

// ── run ──
const N = Number(process.argv[2] ?? 300);
seed = Number(process.argv[3] ?? 20260901);
const results = [];
for (let i = 0; i < N; i++) results.push(runGame(2 + int(3))); // 2-4 players (small board)

const fin = results.filter((r) => r.finished);
const withLeader = fin.filter((r) => r.leaderAtRound10 != null);
const pct = (n, d) => d ? ((n / d) * 100).toFixed(1) + '%' : 'n/a';
const q = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const sum = (a) => a.reduce((s, x) => s + x, 0);
const allJack = results.flatMap((r) => r.jackpots);
const totalBuilds = sum(results.map((r) => r.builds.total));
const monoBuilds = sum(results.map((r) => r.builds.withMonopoly));
const jailEarly = sum(results.map((r) => r.jailTurns.early));
const jailLate = sum(results.map((r) => r.jailTurns.late));

console.log(`\n════ ĐO CÂN BẰNG — ${N} ván, bàn 'small' thật, 2-4 người ════`);
console.log(`Ván kết thúc trọn vẹn: ${fin.length}/${N}`);
console.log(`\n── 1. SNOWBALL (mốc bạn đặt: 45-60%) ──`);
console.log(`  Người dẫn net worth ở vòng 10 thắng: ${pct(withLeader.filter((r) => r.leaderWon).length, withLeader.length)}  (n=${withLeader.length})`);
console.log(`\n── 2. MONOPOLY CÓ CHẾT KHÔNG (câu hỏi chính) ──`);
console.log(`  Ván có ÍT NHẤT 1 monopoly hoàn thành: ${pct(results.filter((r) => r.monopoliesFormed > 0).length, N)}`);
console.log(`  Số monopoly hình thành / ván (TB): ${(sum(results.map((r) => r.monopoliesFormed)) / N).toFixed(2)}`);
console.log(`  Tổng lượt XÂY NHÀ: ${totalBuilds}`);
console.log(`  → trong đó có monopoly: ${monoBuilds} (${pct(monoBuilds, totalBuilds)})`);
console.log(`  → KHÔNG có monopoly:  ${totalBuilds - monoBuilds} (${pct(totalBuilds - monoBuilds, totalBuilds)})`);
// The decisive test for "is a monopoly worth chasing": win rate of players who
// completed one vs players who never did, compared within the same matches.
const monoSeats = sum(fin.map((r) => r.monoPlayers));
const nonMonoSeats = sum(fin.map((r) => r.nonMonoPlayers));
const monoWins = fin.filter((r) => r.winnerHadMonopoly).length;
console.log(`  ── ĐỘC QUYỀN CÓ ĐÁNG THEO ĐUỔI KHÔNG ──`);
console.log(`  Tỉ lệ thắng khi ĐÃ có monopoly:    ${pct(monoWins, monoSeats)}  (${monoWins}/${monoSeats} suất)`);
console.log(`  Tỉ lệ thắng khi CHƯA từng có:      ${pct(fin.length - monoWins, nonMonoSeats)}  (${fin.length - monoWins}/${nonMonoSeats} suất)`);
const totRent = sum(results.map((r) => r.rentPaid));
const totBonus = sum(results.map((r) => r.rentFromBonus));
console.log(`  Tiền thuê ĐẾN TỪ bonus độc quyền:  ${pct(totBonus, totRent)}  ($${totBonus} / $${totRent})`);
console.log(`\n── 3. FREE PARKING JACKPOT (bạn muốn 200-600) ──`);
console.log(`  Số lần trả: ${allJack.length}  |  trung vị $${q(allJack, 0.5)}`);
console.log(`  p90 $${q(allJack, 0.9)}  |  p99 $${q(allJack, 0.99)}  |  max $${allJack.length ? Math.max(...allJack) : 0}`);
console.log(`  % lần trả vượt $600: ${pct(allJack.filter((x) => x > 600).length, allJack.length)}`);
console.log(`\n── 4. NHÀ TÙ (mốc trước khi đổi luật) ──`);
console.log(`  Lượt ngồi tù — đầu game (vòng <20): ${jailEarly}  |  cuối game (>=20): ${jailLate}`);
console.log(`\n── 5. ĐỘ DÀI & KẾT THÚC ──`);
const byReason = {};
for (const r of fin) byReason[r.endReason] = (byReason[r.endReason] ?? 0) + 1;
console.log(`  Số vòng TB: ${(sum(fin.map((r) => r.rounds)) / (fin.length || 1)).toFixed(1)}  |  trung vị ${q(fin.map((r) => r.rounds), 0.5)}`);
console.log(`  Kiểu kết thúc: ${Object.entries(byReason).map(([k, v]) => `${k} ${pct(v, fin.length)}`).join('  |  ')}`);
console.log(`\n── 6. KHAN HIẾM NHÀ (32) ──`);
console.log(`  Nguồn nhà thấp nhất chạm tới (TB): ${(sum(results.map((r) => r.minHouseSupply)) / N).toFixed(1)}/32`);
console.log(`  % ván nguồn nhà xuống dưới 10: ${pct(results.filter((r) => r.minHouseSupply < 10).length, N)}`);
console.log(`  % ván CẠN SẠCH nhà (=0): ${pct(results.filter((r) => r.minHouseSupply === 0).length, N)}`);
console.log('');

const stuck = results.filter((r) => !r.finished);
if (stuck.length) {
  const byPhase = {};
  for (const r of stuck) byPhase[r.stuckPhase] = (byPhase[r.stuckPhase] ?? 0) + 1;
  console.log(`── CHẨN ĐOÁN: ${stuck.length} ván chưa kết thúc ──`);
  console.log(`  phase kẹt: ${Object.entries(byPhase).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  vòng TB khi kẹt: ${(sum(stuck.map((r) => r.rounds)) / stuck.length).toFixed(1)}  |  bước TB: ${(sum(stuck.map((r) => r.steps)) / stuck.length).toFixed(0)}`);
  console.log(`  số người còn sống TB: ${(sum(stuck.map((r) => r.stuckAlive)) / stuck.length).toFixed(2)}`);
  console.log('');
}
