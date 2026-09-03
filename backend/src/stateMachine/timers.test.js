import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimerManager, computeDeadline, buildDefaultAction, TIMER_DURATIONS_SECONDS } from './timers.js';
import { transitionTurn } from './turnMachine.js';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';
import { createGameState, createPlayerGameState } from '../domain/gameState.js';
import { EVENT_CARDS } from '../domain/eventDictionary.js';

// A fake schedule/cancel pair — no real setTimeout waits anywhere in this
// file, per the task's own explicit test requirement.
function fakeScheduler() {
  const scheduled = [];
  let nextHandle = 1;
  return {
    calls: scheduled,
    schedule(callback, delayMs) {
      const handle = nextHandle++;
      scheduled.push({ handle, delayMs, callback, cancelled: false });
      return handle;
    },
    cancel(handle) {
      const entry = scheduled.find((e) => e.handle === handle);
      if (entry) entry.cancelled = true;
    },
    fire(handle) {
      const entry = scheduled.find((e) => e.handle === handle);
      if (!entry) throw new Error(`fakeScheduler.fire: no such handle ${handle}`);
      if (!entry.cancelled) entry.callback();
    },
  };
}

test('computeDeadline adds the exact per-phase duration to now', () => {
  const now = '2026-08-17T00:00:00.000Z';
  assert.equal(computeDeadline(now, 'ROLLING'), '2026-08-17T00:00:20.000Z');
  assert.equal(computeDeadline(now, 'JAIL_DECISION'), '2026-08-17T00:00:20.000Z');
  assert.equal(computeDeadline(now, 'AWAITING_PURCHASE'), '2026-08-17T00:00:15.000Z');
  assert.equal(computeDeadline(now, 'POST_ACTIONS'), '2026-08-17T00:00:30.000Z');
});

// REMOVED 2026-08-25 (was: "computeDeadline returns a 15-second offset for
// RENT_RISK_DECISION" / "buildDefaultAction: RENT_RISK_DECISION defaults to
// the safe Standard choice, never Gamble") — Rent Risk Choice no longer has
// a phase or a timeout at all; GAMBLE_RENT is a non-blocking side action,
// asserted not to need a timer at all by the "no stall points left" test
// below (it isn't in `blocksOnAHuman`).
test('computeDeadline throws for RENT_RISK_DECISION — it is not a real phase any more', () => {
  assert.throws(() => computeDeadline('2026-08-21T00:00:00.000Z', 'RENT_RISK_DECISION'), Error);
});

test('computeDeadline returns a 15-second offset for TURN_START', () => {
  assert.equal(computeDeadline('2026-08-21T00:00:00.000Z', 'TURN_START'), '2026-08-21T00:00:15.000Z');
});

test('buildDefaultAction: TURN_START defaults to a plain START_TURN, no payload', () => {
  assert.deepEqual(buildDefaultAction('TURN_START', {}), { type: 'START_TURN' });
});

test('computeDeadline returns a 15-second offset for FLASH_AUCTION_ACTIVE', () => {
  assert.equal(computeDeadline('2026-08-17T00:00:00.000Z', 'FLASH_AUCTION_ACTIVE'), '2026-08-17T00:00:15.000Z');
});

test('computeDeadline throws for a phase with no timed default', () => {
  assert.throws(() => computeDeadline('2026-08-17T00:00:00.000Z', 'DRAWING_CARD'));
});

test('buildDefaultAction: AWAITING_PURCHASE defaults to decline', () => {
  assert.deepEqual(buildDefaultAction('AWAITING_PURCHASE', {}), { type: 'DECLINE_PURCHASE' });
});

test('buildDefaultAction: POST_ACTIONS defaults to end_turn', () => {
  assert.deepEqual(buildDefaultAction('POST_ACTIONS', {}), { type: 'END_TURN' });
});

test('buildDefaultAction: FLASH_AUCTION_ACTIVE defaults to AUCTION_TIMEOUT, no payload', () => {
  assert.deepEqual(buildDefaultAction('FLASH_AUCTION_ACTIVE', {}), { type: 'AUCTION_TIMEOUT' });
});

test('buildDefaultAction: JAIL_DECISION defaults to a fresh (streak 0) attempt_jail_roll', () => {
  // boardTiles (4th positional slot, added for LIQUIDATION_REQUIRED) is
  // irrelevant here — explicit [] so randomSource lands in the right slot.
  const action = buildDefaultAction('JAIL_DECISION', {}, [], () => 0); // forces die1=die2=1 -> doubles
  assert.equal(action.type, 'ATTEMPT_JAIL_ROLL');
  assert.equal(action.payload.doublesStreak, 1); // rolled from a fresh streak of 0
});

test('buildDefaultAction: ROLLING threads gameState.currentDoublesStreak into rollDice', () => {
  const gameState = { currentDoublesStreak: 1 };
  const action = buildDefaultAction('ROLLING', gameState, [], () => 0); // forces another double
  assert.equal(action.type, 'ROLL_DICE');
  assert.equal(action.payload.doublesStreak, 2); // continues from streak 1, not reset to 0
});

test('buildDefaultAction: PLAYING_CARD defaults to the first card in hand', () => {
  const gameState = {
    currentTurnPlayerId: 'p1',
    players: [{ id: 'p1', movementHand: ['MOVE_7', 'MOVE_5'] }]
  };
  const action = buildDefaultAction('PLAYING_CARD', gameState);
  assert.equal(action.type, 'PLAY_MOVEMENT_CARD');
  assert.equal(action.payload.cardId, 'MOVE_7');
});

test('buildDefaultAction: PLAYING_CARD throws if hand is empty (invariant violated)', () => {
  const gameState = {
    currentTurnPlayerId: 'p1',
    players: [{ id: 'p1', movementHand: [] }] // Empty hand
  };
  assert.throws(() => buildDefaultAction('PLAYING_CARD', gameState), /violates invariant/);
});

test('buildDefaultAction throws for an untimed phase', () => {
  assert.throws(() => buildDefaultAction('DRAWING_CARD', {}));
});

test('computeDeadline returns a 45-second offset for LIQUIDATION_REQUIRED', () => {
  assert.equal(computeDeadline('2026-08-21T00:00:00.000Z', 'LIQUIDATION_REQUIRED'), '2026-08-21T00:00:45.000Z');
});

// --- LIQUIDATION_REQUIRED's own default action (Win Condition design §E2,
// wired 2026-08-21): "auto-liquidate, cheapest [asset] first" across the
// debtor's whole portfolio — must respect the even-sell rule (only the
// group's current highest-level member is sell-eligible) and the per-property
// PROPERTY_HAS_HOUSES mortgage block exactly like turnMachine.js's real
// handlers, or a synthesized default could get rejected by transitionTurn
// (which stalls the room — see buildLiquidationDefaultAction's own header).

function liquidationBoard() {
  return [
    // Same "red" group, two members — 'la' ahead of 'lb'.
    createTile({ id: 'la', boardId: 'small', position: 1, tileType: 'property', name: 'Red A', groupId: 'red', price: 100, houseCost: 50, mortgageValue: 30 }),
    createTile({ id: 'lb', boardId: 'small', position: 2, tileType: 'property', name: 'Red B', groupId: 'red', price: 100, houseCost: 50, mortgageValue: 30 }),
    // Standalone, no group.
    createTile({ id: 'lc', boardId: 'small', position: 3, tileType: 'property', name: 'Standalone', price: 120, houseCost: 100, mortgageValue: 40 }),
  ];
}

function liquidationGameState({ lcMortgageValue } = {}) {
  const tiles = liquidationBoard();
  if (lcMortgageValue != null) tiles[2] = { ...tiles[2], mortgageValue: lcMortgageValue };
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'alice', turnOrder: 0, currentBalance: 5 }),
  ];
  const properties = [
    createProperty({ id: 'p-la', gameId: 'g1', boardTileId: 'la', ownerId: 'gp-alice', upgradeLevel: 2 }),
    createProperty({ id: 'p-lb', gameId: 'g1', boardTileId: 'lb', ownerId: 'gp-alice', upgradeLevel: 1 }), // behind 'la' in the same group
    createProperty({ id: 'p-lc', gameId: 'g1', boardTileId: 'lc', ownerId: 'gp-alice', upgradeLevel: 0 }),
  ];
  return {
    tiles,
    gameState: createGameState({
      id: 'g1',
      roomId: 'r1',
      boardId: 'small',
      status: 'in_progress',
      phase: 'LIQUIDATION_REQUIRED',
      currentTurnIndex: 0,
      players,
      properties,
      pendingLiquidation: { debtorId: 'gp-alice', creditorId: 'gp-bank', amount: 50, transactionType: 'tax' },
      startedAt: '2026-08-21T00:00:00.000Z',
    }),
  };
}

test('buildDefaultAction: LIQUIDATION_REQUIRED picks the cheapest valid target across SELL_HOUSE and MORTGAGE candidates', () => {
  const { tiles, gameState } = liquidationGameState();
  // Candidates: SELL_HOUSE on p-la (even-sell eligible, floor(50*0.5)=25) —
  // p-lb is NOT eligible (behind the group's max level 2). MORTGAGE on
  // p-la/p-lb both blocked by PROPERTY_HAS_HOUSES (each has houses of its
  // own); MORTGAGE on p-lc is eligible (standalone, unmortgaged, no
  // houses), value 40. 25 < 40, so SELL_HOUSE on p-la wins.
  const action = buildDefaultAction('LIQUIDATION_REQUIRED', gameState, tiles);
  assert.deepEqual(action, { type: 'SELL_HOUSE', payload: { propertyId: 'p-la' } });
});

test('buildDefaultAction: LIQUIDATION_REQUIRED picks MORTGAGE when it is genuinely cheaper than any eligible sale', () => {
  const { tiles, gameState } = liquidationGameState({ lcMortgageValue: 10 }); // now 10 < the 25 sellback
  const action = buildDefaultAction('LIQUIDATION_REQUIRED', gameState, tiles);
  assert.deepEqual(action, { type: 'MORTGAGE', payload: { propertyId: 'p-lc' } });
});

test('buildDefaultAction: LIQUIDATION_REQUIRED throws if the debtor genuinely has nothing left to liquidate (defensive — should be unreachable via checkSolvency)', () => {
  const { tiles, gameState } = liquidationGameState();
  const nothingLeft = {
    ...gameState,
    properties: gameState.properties.map((p) => ({ ...p, upgradeLevel: 0, mortgaged: true })),
  };
  assert.throws(() => buildDefaultAction('LIQUIDATION_REQUIRED', nothingLeft, tiles), /nothing left to liquidate/);
});

test('buildDefaultAction: LIQUIDATION_REQUIRED result actually passes transitionTurn — same "no separate timeout code path" guarantee as every other phase', () => {
  const { tiles, gameState } = liquidationGameState();
  const action = buildDefaultAction('LIQUIDATION_REQUIRED', gameState, tiles);
  const { gameState: next } = transitionTurn(gameState, tiles, action);
  const property = next.properties.find((p) => p.id === 'p-la');
  assert.equal(property.upgradeLevel, 1); // one house sold
});

test('TimerManager.start schedules with the exact delay for the phase and returns deadlineAt', () => {
  const fake = fakeScheduler();
  const manager = new TimerManager({ schedule: fake.schedule, cancel: fake.cancel, now: () => '2026-08-17T00:00:00.000Z' });

  const deadlineAt = manager.start('room1', 'AWAITING_PURCHASE', () => {});

  assert.equal(deadlineAt, '2026-08-17T00:00:15.000Z');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].delayMs, 15000);
});

test('TimerManager fires onTimeout with the correct phase and deadlineAt when the timer elapses', () => {
  const fake = fakeScheduler();
  const manager = new TimerManager({ schedule: fake.schedule, cancel: fake.cancel, now: () => '2026-08-17T00:00:00.000Z' });

  let fired = null;
  const deadlineAt = manager.start('room1', 'ROLLING', (phase, deadline) => {
    fired = { phase, deadline };
  });

  assert.equal(fired, null); // not fired yet — no real time has passed, and nothing calls fire() until we do
  fake.fire(1);
  assert.deepEqual(fired, { phase: 'ROLLING', deadline: deadlineAt });
});

test('cancelling before the timer fires prevents onTimeout from ever being called', () => {
  const fake = fakeScheduler();
  const manager = new TimerManager({ schedule: fake.schedule, cancel: fake.cancel, now: () => '2026-08-17T00:00:00.000Z' });

  let fired = false;
  manager.start('room1', 'ROLLING', () => {
    fired = true;
  });
  manager.cancel('room1');
  fake.fire(1); // the underlying scheduled callback still exists, but is marked cancelled

  assert.equal(fired, false);
  assert.equal(manager.isActive('room1'), false);
});

test('starting a new timer for a room that already has one replaces it — at most one per room', () => {
  const fake = fakeScheduler();
  const manager = new TimerManager({ schedule: fake.schedule, cancel: fake.cancel, now: () => '2026-08-17T00:00:00.000Z' });

  manager.start('room1', 'ROLLING', () => {
    throw new Error('the first (replaced) timer should never fire');
  });
  let secondFired = false;
  manager.start('room1', 'AWAITING_PURCHASE', () => {
    secondFired = true;
  });

  fake.fire(1); // the first timer's handle — cancelled by the second start()
  fake.fire(2); // the second timer's handle — genuinely fires
  assert.equal(secondFired, true);
});

test('isActive and deadlineFor reflect the current state accurately', () => {
  const fake = fakeScheduler();
  const manager = new TimerManager({ schedule: fake.schedule, cancel: fake.cancel, now: () => '2026-08-17T00:00:00.000Z' });

  assert.equal(manager.isActive('room1'), false);
  assert.equal(manager.deadlineFor('room1'), null);

  const deadlineAt = manager.start('room1', 'POST_ACTIONS', () => {});
  assert.equal(manager.isActive('room1'), true);
  assert.equal(manager.deadlineFor('room1'), deadlineAt);

  fake.fire(1);
  assert.equal(manager.isActive('room1'), false); // cleared on fire, same as on cancel
});

test('cancelling a room with no active timer is a harmless no-op', () => {
  const fake = fakeScheduler();
  const manager = new TimerManager({ schedule: fake.schedule, cancel: fake.cancel });
  assert.doesNotThrow(() => manager.cancel('no-such-room'));
});

// --- Integration: proves §7's "same apply pipeline, no separate timeout
// code path" requirement — a timed-out default action produces exactly
// the same GameState transition a real player action would.

const board = [
  createTile({ id: 't0', boardId: 'small', position: 0, tileType: 'go', name: 'GO' }),
  createTile({
    id: 't1',
    boardId: 'small',
    position: 1,
    tileType: 'property',
    name: 'Test Ave',
    price: 60,
    baseRent: 2,
    rentTable: [10, 30, 90, 160, 250],
    houseCost: 50,
    mortgageValue: 30,
  }),
  ...Array.from({ length: 34 }, (_, i) =>
    createTile({ id: `t${i + 2}`, boardId: 'small', position: i + 2, tileType: 'property', name: 'Filler', price: 80, baseRent: 4, rentTable: [20, 60, 180, 320, 450], houseCost: 50, mortgageValue: 40 })
  ),
];

function integrationGameState() {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'alice', turnOrder: 0, currentBalance: 1500, currentPosition: 1 }),
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'bob', turnOrder: 1, currentBalance: 1500 }),
  ];
  const properties = board.slice(1).map((t) => createProperty({ id: `p${t.position}`, gameId: 'g1', boardTileId: t.id }));
  return createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'AWAITING_PURCHASE',
    currentTurnIndex: 0,
    players,
    properties,
    startedAt: '2026-08-17T00:00:00.000Z',
  });
}

// REWRITTEN for Auction V2 ("Nhà Môi Giới", 2026-09-01). Under V1 a declining
// player was charged an auction fee automatically, so a TIMEOUT also charged
// it and opened an auction — which is what these two tests asserted. V2 splits
// that into SKIP_PURCHASE (free) and FORCE_AUCTION (pay the fee, earn the
// broker commission), and a timeout must never pick the paying branch on an
// absent player's behalf. buildDefaultAction's `DECLINE_PURCHASE` is the
// legacy alias for SKIP_PURCHASE, so a timeout is now free — correct, and the
// behaviour these tests now pin.
test('integration: an AWAITING_PURCHASE timeout skips for free — it never opens a fee-charging auction on an absent player', () => {
  const gameState = integrationGameState();
  const action = buildDefaultAction('AWAITING_PURCHASE', gameState);
  const { gameState: viaTimeout } = transitionTurn(gameState, board, action);
  const { gameState: viaRealAction } = transitionTurn(gameState, board, { type: 'SKIP_PURCHASE' });

  assert.deepEqual(viaTimeout, viaRealAction, 'the timeout path and a real SKIP_PURCHASE agree exactly');
  assert.equal(viaTimeout.phase, 'POST_ACTIONS');
  assert.equal(
    viaTimeout.players.find((p) => p.id === 'gp-alice').currentBalance,
    1500,
    'an absent player is charged nothing — V2 makes the fee opt-in via FORCE_AUCTION'
  );
});

test('integration: a full TimerManager firing drives a real transitionTurn call end to end', () => {
  const fake = fakeScheduler();
  const manager = new TimerManager({ schedule: fake.schedule, cancel: fake.cancel, now: () => '2026-08-17T00:00:00.000Z' });
  const gameState = integrationGameState();

  let resultState = null;
  manager.start('room1', 'AWAITING_PURCHASE', (phase) => {
    const action = buildDefaultAction(phase, gameState);
    ({ gameState: resultState } = transitionTurn(gameState, board, action));
  });

  fake.fire(1);

  assert.ok(resultState);
  assert.equal(resultState.phase, 'POST_ACTIONS');
  assert.equal(resultState.properties.find((p) => p.boardTileId === 't1').ownerId, null); // skipped, not bought
  assert.equal(resultState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500); // no fee on a timeout
});

// ============================================================
// Finding #35 (2026-08-23): the two blocking phases that had no timer.
// ============================================================
// These were the only two phases in turnMachine.js's VALID_ACTIONS_BY_PHASE
// that wait on a real human action while having no entry in
// TIMER_DURATIONS_SECONDS. socketServer.js's scheduleTurnTimer() *cancels*
// the room timer for any unlisted phase, so a disconnect at either moment
// stalled the whole match permanently.

test('finding #35: every phase that blocks on a human action has a timeout — no stall points left', () => {
  // VALID_ACTIONS_BY_PHASE's own keys (turnMachine.js). Not imported — that
  // map is deliberately private; this list is the assertion's real subject,
  // so a future phase added there without a timer should fail HERE, loudly,
  // rather than silently becoming a new stall point in production.
  // RENT_RISK_DECISION deliberately absent as of 2026-08-25 — it is no
  // longer a real phase (Rent Risk Choice's GAMBLE_RENT is a non-blocking
  // side action, dispatched before VALID_ACTIONS_BY_PHASE is even
  // consulted, same as FORFEIT_MATCH), so it correctly needs no timer.
  const blocksOnAHuman = [
    'TURN_START',
    'JAIL_DECISION',
    'ROLLING',
    'AWAITING_PURCHASE',
    'AWAITING_UPGRADE',
    'FLASH_AUCTION_ACTIVE',
    'AWAITING_EVENT_CHOICE',
    'POST_ACTIONS',
    'LIQUIDATION_REQUIRED',
  ];
  for (const phase of blocksOnAHuman) {
    assert.ok(
      phase in TIMER_DURATIONS_SECONDS,
      `'${phase}' blocks the match on one player's action but has no timeout — a disconnect there stalls the game forever`
    );
    assert.doesNotThrow(() => computeDeadline('2026-08-17T00:00:00.000Z', phase), `computeDeadline must work for '${phase}'`);
  }
});

test('finding #35: AWAITING_UPGRADE times out to DECLINE_UPGRADE — identical to a real decline, never a build the player never asked for', () => {
  const base = integrationGameState();
  const gameState = { ...base, phase: 'AWAITING_UPGRADE' };
  const action = buildDefaultAction('AWAITING_UPGRADE', gameState);
  assert.deepEqual(action, { type: 'DECLINE_UPGRADE' });

  const { gameState: viaTimeout } = transitionTurn(gameState, board, action);
  const { gameState: viaRealAction } = transitionTurn(gameState, board, { type: 'DECLINE_UPGRADE' });
  assert.deepEqual(viaTimeout, viaRealAction);
  // The player's money is untouched — the whole point of defaulting to decline.
  assert.equal(viaTimeout.players.find((p) => p.id === 'gp-alice').currentBalance, 1500);
});

test('finding #35: AWAITING_UPGRADE is a real member of GAME_PHASES, so createGameState accepts it', () => {
  // It was genuinely reachable (resolveTile.js returns it) but missing from
  // the enum — latent only because transitions spread plain objects and the
  // snapshot restore path skips createGameState() entirely.
  assert.doesNotThrow(() => createGameState({ ...integrationGameState(), phase: 'AWAITING_UPGRADE' }));
});

test('finding #35: AWAITING_EVENT_CHOICE times out to a real, ACCEPTED choice on every CHOICE card in the deck', () => {
  // The critical property: a synthesized default that gets REJECTED leaves
  // the room stalled with no timer covering it (handleTurnTimeout's own
  // warning), i.e. exactly the bug this fix exists to close. So this drives
  // each card through a real transitionTurn and asserts it actually
  // resolves, rather than only checking the payload's shape.
  const choiceCards = Object.values(EVENT_CARDS).filter((c) => c.type === 'CHOICE');
  assert.ok(choiceCards.length > 0);

  for (const card of choiceCards) {
    for (const balance of [0, 60, 5000]) {
      // Only states the real game can actually produce are in scope here.
      // resolveDrawingCard() consults cardEligible() BEFORE ever entering
      // AWAITING_EVENT_CHOICE, so a card whose own eligibility gate excludes
      // this player never reaches this phase at all — it resolves as a
      // revealed no-op straight to POST_ACTIONS instead. Mirrored inline
      // rather than imported because cardEligible is deliberately private to
      // turnMachine.js; the genuinely-unreachable half (C11 below $50 — the
      // hard deadlock this gate closes) is proven separately, by driving a
      // real draw, in turnMachine.test.js.
      if (card.eligibility) {
        const { field, op, value } = card.eligibility;
        const actual = field === 'currentBalance' ? balance : undefined;
        const eligible = op === 'lt' ? actual < value : op === 'gte' ? actual >= value : true;
        if (!eligible) continue;
      }

      const base = integrationGameState();
      const players = base.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: balance } : p));
      const gameState = { ...base, players, phase: 'AWAITING_EVENT_CHOICE', pendingEventCardId: card.id };

      const action = buildDefaultAction('AWAITING_EVENT_CHOICE', gameState, [], () => 0.5);
      assert.equal(action.type, 'MAKE_EVENT_CHOICE');
      const option = card.options.find((o) => o.id === action.payload.optionId);
      assert.ok(option, `${card.id}: default named an option that does not exist`);

      // Any randomness the chosen option needs must be in this payload —
      // the timeout path does NOT run through socketServer.js's
      // serverGeneratedFields(), unlike a real client action.
      const intents = option.intents ?? [];
      if (intents.some((i) => i.action === 'PROBABILITY')) assert.equal(typeof action.payload.probabilityRoll, 'number');
      if (intents.some((i) => i.action === 'DIE_FACE_REWARD')) assert.equal(typeof action.payload.dieFaceRoll, 'number');

      // The real test: it must be accepted, and must leave the blocking phase.
      const { gameState: after } = transitionTurn(gameState, board, action);
      assert.notEqual(after.phase, 'AWAITING_EVENT_CHOICE', `${card.id} @ $${balance}: still stuck in the blocking phase`);
    }
  }
});

test('finding #35: the timed-out event choice never defaults a player into a gamble when a riskless option exists', () => {
  // Matches this codebase's established rule — "nothing ever defaults
  // *into* a risk" (Rent Risk Choice's own Gamble is always a player
  // opt-in, never a system default). INVESTMENT_OPPORTUNITY is the clean case: a
  // guaranteed +200 alongside a 50/50 that costs 300 up front.
  const base = integrationGameState();
  const gameState = { ...base, phase: 'AWAITING_EVENT_CHOICE', pendingEventCardId: 'INVESTMENT_OPPORTUNITY' };
  const action = buildDefaultAction('AWAITING_EVENT_CHOICE', gameState, [], () => 0.5);

  assert.equal(action.payload.optionId, 'OPT_SAFE');
  assert.equal(action.payload.probabilityRoll, undefined); // no roll generated for an option that needs none

  const { gameState: after } = transitionTurn(gameState, board, action);
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 200);
});
