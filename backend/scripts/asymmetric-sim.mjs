// Monte-Carlo harness for docs/ASYMMETRIC_MODE_SPEC.md V3, Bước 1.
//
// Answers the ONE question every number in the spec depends on: how often
// does a tile actually get PASSED OVER vs LANDED ON, once players can choose
// their destination? Every synergy in §2/§3 is priced against that ratio.
//
// Deliberately standalone — it does NOT import turnMachine. The engine has no
// ASYMMETRIC movement path yet (that's Bước 4), and the point of this script
// is to price the design BEFORE writing it. Board data is the real small-board
// seed, copied from scripts/measure-balance.mjs which copied it from
// supabase/seed/boards.sql.
//
// Run: node backend/scripts/asymmetric-sim.mjs [matches]

// ── Real small board (supabase/seed/boards.sql) ──────────────────────────────
const SEED = [
  [0, 'go'], [1, 'property', 'red', 60, 2, [10, 30, 90, 160, 250], 50],
  [2, 'fortune'],
  [3, 'property', 'red', 60, 4, [20, 60, 180, 320, 450], 50],
  [4, 'tax', null, null, null, null, null, 200],
  [5, 'property', 'cyan', 100, 6, [30, 90, 270, 400, 550], 50],
  [6, 'chance'],
  [7, 'property', 'cyan', 100, 6, [30, 90, 270, 400, 550], 50],
  [8, 'property', 'cyan', 120, 8, [40, 100, 300, 450, 600], 50],
  [9, 'jail'],
  [10, 'property', 'purple', 140, 10, [50, 150, 450, 625, 750], 100],
  [11, 'utility', null, 200],
  [12, 'property', 'purple', 140, 10, [50, 150, 450, 625, 750], 100],
  [13, 'property', 'purple', 160, 12, [60, 180, 500, 700, 900], 100],
  [14, 'transport', null, 200, 25],
  [15, 'property', 'orange', 180, 14, [70, 200, 550, 750, 950], 100],
  [16, 'property', 'orange', 180, 14, [70, 200, 550, 750, 950], 100],
  [17, 'property', 'orange', 200, 16, [80, 220, 600, 800, 1000], 100],
  [18, 'free_parking'],
  [19, 'property', 'yellow', 220, 18, [90, 250, 700, 875, 1050], 150],
  [20, 'chance'],
  [21, 'property', 'yellow', 220, 18, [90, 250, 700, 875, 1050], 150],
  [22, 'property', 'yellow', 240, 20, [100, 300, 750, 925, 1100], 150],
  [23, 'property', 'green', 260, 22, [110, 330, 800, 975, 1150], 100],
  [24, 'property', 'green', 260, 22, [110, 330, 800, 975, 1150], 100],
  [25, 'utility', null, 200],
  [26, 'property', 'green', 280, 24, [120, 360, 850, 1025, 1200], 100],
  [27, 'go_to_jail'],
  [28, 'property', 'blue', 300, 26, [130, 390, 900, 1100, 1275], 200],
  [29, 'property', 'blue', 300, 26, [130, 390, 900, 1100, 1275], 200],
  [30, 'fortune'],
  [31, 'property', 'blue', 320, 28, [150, 450, 1000, 1200, 1400], 200],
  [32, 'transport', null, 200, 25],
  [33, 'property', 'darkblue', 350, 35, [175, 500, 1100, 1300, 1500], 200],
  [34, 'tax', null, null, null, null, null, 100],
  [35, 'property', 'darkblue', 400, 50, [200, 600, 1400, 1700, 2000], 200],
];
const BOARD = SEED.map(([position, tileType, groupId, price, baseRent, rentTable, houseCost, taxAmount]) => ({
  position, tileType, groupId: groupId ?? null, price: price ?? null,
  baseRent: baseRent ?? null, rentTable: rentTable ?? null,
  houseCost: houseCost ?? null, taxAmount: taxAmount ?? null,
}));
const N = BOARD.length;
const OWNABLE = BOARD.filter((t) => ['property', 'transport', 'utility'].includes(t.tileType)).map((t) => t.position);

// ── V3 §2 archetypes: groupId -> archetype (spec's own quadrant mapping) ─────
const ARCHETYPE = {
  red: 'CONTROL', cyan: 'CONTROL',
  purple: 'ECONOMY', orange: 'ECONOMY',
  yellow: 'DENIAL', green: 'DENIAL',
  blue: 'EXECUTION', darkblue: 'EXECUTION',
};
const archetypeOf = (t) =>
  t.tileType === 'transport' ? 'MOBILITY'
  : t.tileType === 'utility' ? 'INFRA'
  : ARCHETYPE[t.groupId] ?? null;

// ── Movement deck: src/domain/movementDictionary.js, verbatim ────────────────
// RANDOM cards are simulated as actually random (the shipped code's
// `steps > 0 ? steps : 1` mock is a bug being fixed in Bước 4, not a design).
const DECKS = {
  // Bộ bài hiện tại (movementDictionary.js) — trung bình 3.0 bước/lượt.
  v1: [
    { id: 'MOVE_1', steps: 1, dir: 1, cost: 0 }, { id: 'MOVE_2', steps: 2, dir: 1, cost: 0 },
    { id: 'MOVE_3', steps: 3, dir: 1, cost: 0 }, { id: 'MOVE_4', steps: 4, dir: 1, cost: 0 },
    { id: 'MOVE_5', steps: 5, dir: 1, cost: 0 }, { id: 'MOVE_6', steps: 6, dir: 1, cost: 0 },
    { id: 'SPRINT_6', steps: 6, dir: 1, cost: 50 }, { id: 'SPRINT_8', steps: 8, dir: 1, cost: 100 },
    { id: 'BACKUP_1', steps: 1, dir: -1, cost: 0 }, { id: 'BACKUP_2', steps: 2, dir: -1, cost: 0 },
    { id: 'BACKUP_3', steps: 3, dir: -1, cost: 0 },
    { id: 'RANDOM_1_6', rand: [1, 6], dir: 1, cost: 0 },
    { id: 'RANDOM_2_12', rand: [2, 12], dir: 1, cost: 0 },
  ],
  // Bộ bài đề xuất — dịch phổ bước lên để nhịp độ khớp CLASSIC (2d6 = 7).
  fast: [
    { id: 'MOVE_4', steps: 4, dir: 1, cost: 0 }, { id: 'MOVE_5', steps: 5, dir: 1, cost: 0 },
    { id: 'MOVE_6', steps: 6, dir: 1, cost: 0 }, { id: 'MOVE_7', steps: 7, dir: 1, cost: 0 },
    { id: 'MOVE_8', steps: 8, dir: 1, cost: 0 }, { id: 'MOVE_9', steps: 9, dir: 1, cost: 0 },
    { id: 'SPRINT_12', steps: 12, dir: 1, cost: 100 },
    { id: 'BACKUP_3', steps: 3, dir: -1, cost: 0 }, { id: 'BACKUP_5', steps: 5, dir: -1, cost: 50 },
    { id: 'RANDOM_2_12', rand: [2, 12], dir: 1, cost: 0 },
  ],
};
const DECK = DECKS[process.env.DECKSET ?? 'v1'];

const PASS_GO = 200;
const START_CASH = 1500;
const ROUNDS = 45;
const PLAYERS = 4;
const HAND = Number(process.env.HAND ?? 3);
const EXEC_TOLL_PER_LEVEL = 25; // V3 §3.2
const JAIL_FINE = 50;           // engine/jail.js

// Deterministic LCG so runs are reproducible.
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const int = (n) => Math.floor(rnd() * n);
const draw = () => DECK[int(DECK.length)];
const roll2d6 = () => (1 + int(6)) + (1 + int(6));

const rentOf = (tile, prop, ownerHoldings) => {
  if (!prop || prop.owner === null) return 0;
  if (tile.tileType === 'transport') return tile.baseRent * 2 ** (ownerHoldings.transport - 1);
  if (tile.tileType === 'utility') return 40 * ownerHoldings.utility;
  if (prop.level === 0) {
    const group = BOARD.filter((t) => t.groupId === tile.groupId);
    const full = group.every((t) => state.props[t.position].owner === prop.owner);
    return full ? tile.baseRent * 2 : tile.baseRent;
  }
  return tile.rentTable[prop.level - 1];
};

let state; // current match, module-scoped so rentOf can see it

// ── Metrics ─────────────────────────────────────────────────────────────────
const blank = () => ({
  passes: Array(N).fill(0),      // times an opponent CROSSED an owned tile
  landings: Array(N).fill(0),    // times an opponent STOPPED on an owned tile
  rentPaid: 0, tollPaid: 0, taxPaid: 0, goSalary: 0,
  turns: 0, laps: 0, bankrupt: 0, soldTiles: 0, jailBypass: 0, finished: 0,
  byArch: {}, forcedChoice: 0, forcedPick: {},
});
const add = (acc, m) => {
  for (let i = 0; i < N; i++) { acc.passes[i] += m.passes[i]; acc.landings[i] += m.landings[i]; }
  for (const k of ['rentPaid', 'tollPaid', 'taxPaid', 'goSalary', 'turns', 'laps', 'bankrupt', 'soldTiles', 'jailBypass', 'finished', 'forcedChoice'])
    acc[k] += m[k];
  for (const [k, v] of Object.entries(m.byArch)) acc.byArch[k] = (acc.byArch[k] ?? 0) + v;
  for (const [k, v] of Object.entries(m.forcedPick)) acc.forcedPick[k] = (acc.forcedPick[k] ?? 0) + v;
};

// ── One match ───────────────────────────────────────────────────────────────
// mode: 'CLASSIC' (2d6) | 'ASYM_DODGE' (3 cards, avoids cost) | 'ASYM_TEMPO' (3 cards, max distance)
function playMatch(mode) {
  const m = blank();
  const asym = mode !== 'CLASSIC';
  state = {
    props: Object.fromEntries(OWNABLE.map((p) => [p, { owner: null, level: 0 }])),
    players: Array.from({ length: PLAYERS }, () => ({
      pos: 0, cash: START_CASH, hand: asym ? Array.from({ length: HAND }, draw) : [], alive: true, jail: 0,
    })),
  };
  const holdings = (pi) => ({
    transport: OWNABLE.filter((p) => BOARD[p].tileType === 'transport' && state.props[p].owner === pi).length,
    utility: OWNABLE.filter((p) => BOARD[p].tileType === 'utility' && state.props[p].owner === pi).length,
  });

  // Cost of stopping on `pos` for player `pi` — drives the dodge policy.
  const landCost = (pi, pos) => {
    const t = BOARD[pos], p = state.props[pos];
    if (t.tileType === 'tax') return t.taxAmount;
    if (t.tileType === 'go_to_jail') return JAIL_FINE + PASS_GO; // fine + forfeited salary
    if (!p || p.owner === null || p.owner === pi) return 0;
    return rentOf(t, p, holdings(p.owner));
  };
  // Toll accrued walking from `from` to `to` (exclusive of `from`, inclusive of `to`).
  const walkTolls = (pi, from, steps, dir) => {
    let cur = from, toll = 0, hits = 0, passedGo = false;
    for (let s = 0; s < steps; s++) {
      const raw = cur + dir;
      if (dir === 1 && raw >= N) passedGo = true;
      cur = (raw + N) % N;
      if (s === steps - 1) break; // final tile is a LANDING, not a pass-through
      const t = BOARD[cur], p = state.props[cur];
      if (!p || p.owner === null || p.owner === pi) continue;
      if (hits >= 2) continue; // V3 §1.3 global pass-through cap
      hits++;
      if (archetypeOf(t) === 'EXECUTION') toll += p.level * EXEC_TOLL_PER_LEVEL;
    }
    return { dest: cur, toll, passedGo };
  };

  for (let round = 0; round < ROUNDS; round++) {
    for (let pi = 0; pi < PLAYERS; pi++) {
      const P = state.players[pi];
      if (!P.alive) continue;
      if (P.jail > 0) { P.jail--; P.cash -= JAIL_FINE; continue; }

      m.turns++;
      let steps, dir = 1, cardCost = 0;
      if (!asym) {
        steps = roll2d6();
      } else {
        // Evaluate every card in hand; pick by policy.
        const opts = P.hand.map((c, idx) => {
          const s = c.rand ? c.rand[0] + int(c.rand[1] - c.rand[0] + 1) : c.steps;
          const w = walkTolls(pi, P.pos, s, c.dir);
          const total = landCost(pi, w.dest) + w.toll + c.cost - (w.passedGo ? PASS_GO : 0);
          return { idx, c, s, total, dest: w.dest, forward: c.dir * s };
        });
        let best;
        if (mode === 'ASYM_TEMPO') {
          best = opts.reduce((a, b) => (b.forward > a.forward ? b : a));
        } else {
          const min = Math.min(...opts.map((o) => o.total));
          // Every option costs something -> this is the "lesser evil" case.
          if (min > 0) {
            m.forcedChoice++;
            const t = BOARD[opts.find((o) => o.total === min).dest];
            const a = archetypeOf(t) ?? t.tileType;
            m.forcedPick[a] = (m.forcedPick[a] ?? 0) + 1;
          }
          const tied = opts.filter((o) => o.total === min);
          best = tied.reduce((a, b) => (b.forward > a.forward ? b : a));
        }
        steps = best.s; dir = best.c.dir; cardCost = best.c.cost;
        P.hand.splice(best.idx, 1);
        while (P.hand.length < HAND) P.hand.push(draw()); // V3 §1.3 draw rule
      }

      P.cash -= cardCost;

      // Walk tile by tile — this is where pass-through is counted.
      let hits = 0;
      for (let s = 0; s < steps; s++) {
        const raw = P.pos + dir;
        if (dir === 1 && raw >= N) { P.cash += PASS_GO; m.goSalary += PASS_GO; m.laps++; }
        P.pos = (raw + N) % N;
        if (s === steps - 1) break;
        const t = BOARD[P.pos], p = state.props[P.pos];
        if (!p || p.owner === null || p.owner === pi) continue;
        m.passes[P.pos]++;
        const a = archetypeOf(t);
        if (a) m.byArch[a] = (m.byArch[a] ?? 0) + 1;
        if (hits >= 2) continue;
        hits++;
        if (a === 'EXECUTION' && p.level > 0) {
          const toll = p.level * EXEC_TOLL_PER_LEVEL;
          P.cash -= toll; state.players[p.owner].cash += toll; m.tollPaid += toll;
        }
      }

      // ── Landing resolution ──
      const tile = BOARD[P.pos], prop = state.props[P.pos];
      if (tile.tileType === 'tax') { P.cash -= tile.taxAmount; m.taxPaid += tile.taxAmount; }
      else if (tile.tileType === 'go_to_jail') {
        // The ô27 bypass: this skips every EXECUTION tile (28-35) AND GO.
        const skipped = OWNABLE.filter((p) => p > 27 && state.props[p].owner !== null && state.props[p].owner !== pi);
        if (skipped.length) m.jailBypass++;
        P.pos = 9; P.jail = 1;
      } else if (prop) {
        if (prop.owner === null) {
          const price = tile.price;
          if (P.cash >= price + 300) { prop.owner = pi; P.cash -= price; }
        } else if (prop.owner !== pi) {
          m.landings[P.pos]++;
          let rent = rentOf(tile, prop, holdings(prop.owner));
          if (archetypeOf(tile) === 'CONTROL') rent = Math.floor(rent * 1.5); // V3 §2.1
          P.cash -= rent; state.players[prop.owner].cash += rent; m.rentPaid += rent;
        }
      }

      // Build: full group + comfortable cash (same "reasonable player" bar as measure-balance).
      if (P.cash > 600) {
        for (const gid of new Set(BOARD.filter((t) => t.groupId).map((t) => t.groupId))) {
          const g = BOARD.filter((t) => t.groupId === gid);
          if (!g.every((t) => state.props[t.position].owner === pi)) continue;
          const target = g.map((t) => state.props[t.position]).sort((a, b) => a.level - b.level)[0];
          if (target.level < 5 && P.cash >= g[0].houseCost + 500) { target.level++; P.cash -= g[0].houseCost; }
        }
      }

      if (P.cash < 0) { P.alive = false; m.bankrupt++; }
    }
    if (state.players.filter((p) => p.alive).length <= 1) { m.finished++; break; }
  }
  m.soldTiles = OWNABLE.filter((p) => state.props[p].owner !== null).length;
  return m;
}

// ── Run ─────────────────────────────────────────────────────────────────────
const MATCHES = Number(process.argv[2] ?? 1000);
const results = {};
for (const mode of ['CLASSIC', 'ASYM_DODGE', 'ASYM_TEMPO']) {
  seed = 12345;
  const acc = blank();
  for (let i = 0; i < MATCHES; i++) add(acc, playMatch(mode));
  results[mode] = acc;
}

const per = (v) => (v / MATCHES).toFixed(1);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const money = (v) => '$' + Math.round(v / MATCHES).toLocaleString('en-US');

console.log(`\n=== ASYMMETRIC MODE — Monte Carlo (${MATCHES} ván, bàn small 36 ô, ${PLAYERS} người, ${ROUNDS} vòng) ===\n`);
console.log('CHỈ SỐ CỐT LÕI (trung bình mỗi ván)');
console.log('─'.repeat(78));
console.log('                                    CLASSIC     ASYM(né)   ASYM(chạy)');
const row = (label, f) => console.log(
  label.padEnd(34) + [f(results.CLASSIC), f(results.ASYM_DODGE), f(results.ASYM_TEMPO)].map((x) => String(x).padStart(12)).join('')
);
row('Tổng lần ĐI NGANG QUA đất địch', (r) => per(sum(r.passes)));
row('Tổng lần DẪM TRÚNG đất địch', (r) => per(sum(r.landings)));
row('  → Tỉ lệ Pass : Land', (r) => (sum(r.passes) / Math.max(1, sum(r.landings))).toFixed(1) + ' : 1');
row('  → % lượt dừng trên đất địch', (r) => ((sum(r.landings) / Math.max(1, r.turns)) * 100).toFixed(1) + '%');
row('Số vòng bàn hoàn thành', (r) => per(r.laps));
row('Số ô bán được / 26', (r) => per(r.soldTiles));
row('Ván kết thúc sớm (có người thắng)', (r) => ((r.finished / MATCHES) * 100).toFixed(0) + '%');
row('Số người phá sản', (r) => per(r.bankrupt));
console.log('');
row('Tiền THUÊ đã trả', (r) => money(r.rentPaid));
row('Phí QUÁ CẢNH (Execution)', (r) => money(r.tollPaid));
row('Lương GO nhận', (r) => money(r.goSalary));

console.log('\n\nTẦN SUẤT ĐI NGANG QUA THEO HỆ (trung bình mỗi ván)');
console.log('─'.repeat(78));
const archOrder = ['CONTROL', 'ECONOMY', 'DENIAL', 'EXECUTION', 'MOBILITY', 'INFRA'];
const COST = { CONTROL: 440, ECONOMY: 1000, DENIAL: 1480, EXECUTION: 1670, MOBILITY: 400, INFRA: 400 };
console.log('Hệ            Giá mua      CLASSIC     ASYM(né)   ASYM(chạy)   Lần/$100 vốn');
for (const a of archOrder) {
  const d = results.ASYM_DODGE.byArch[a] ?? 0;
  console.log(
    a.padEnd(13) +
    ('$' + COST[a]).padStart(8) +
    per(results.CLASSIC.byArch[a] ?? 0).padStart(13) +
    per(d).padStart(13) +
    per(results.ASYM_TEMPO.byArch[a] ?? 0).padStart(13) +
    ((d / MATCHES) / (COST[a] / 100)).toFixed(2).padStart(15)
  );
}

console.log('\n\nKHI BỊ DỒN — "LESSER EVIL": người chơi chọn hệ nào để dẫm vào?');
console.log('─'.repeat(78));
const fc = results.ASYM_DODGE;
console.log(`Số lượt mọi lựa chọn đều tốn tiền: ${per(fc.forcedChoice)} lượt/ván`);
for (const [k, v] of Object.entries(fc.forcedPick).sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(14)} ${per(v).padStart(6)} lượt/ván  (${((v / Math.max(1, fc.forcedChoice)) * 100).toFixed(0)}%)`);

console.log('\n\nLỖ HỔNG Ô 27 ("Vào Tù" nhảy qua toàn bộ vùng EXECUTION 28-35)');
console.log('─'.repeat(78));
row('Số lần bypass EXECUTION/ván', (r) => per(r.jailBypass));

console.log('\n\nTOP 6 Ô BỊ ĐI NGANG QUA NHIỀU NHẤT vs BỊ DẪM NHIỀU NHẤT — ASYM(né)');
console.log('─'.repeat(78));
const rank = (arr) => arr.map((v, i) => [i, v]).filter(([i]) => OWNABLE.includes(i)).sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log('  Đi ngang qua:', rank(results.ASYM_DODGE.passes).map(([i, v]) => `ô${i}(${(v / MATCHES).toFixed(1)})`).join('  '));
console.log('  Dẫm trúng:   ', rank(results.ASYM_DODGE.landings).map(([i, v]) => `ô${i}(${(v / MATCHES).toFixed(2)})`).join('  '));
console.log('');
