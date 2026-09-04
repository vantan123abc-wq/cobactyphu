// Counts the Supabase round trips each lobby REST action costs.
//
// Why this matters (measured 2026-09-04): the deployed backend runs in
// Render's `gcp-us-west1` (Oregon) — confirmed from DNS,
// `gcp-us-west1-1.origin.onrender.com` — while Supabase answers from Asia.
// Every one of these round trips is therefore a Pacific crossing of roughly
// 180ms, and they are all SEQUENTIAL. A count here translates almost
// directly into how long a "Sẵn Sàng" click feels for the user.
//
// Run: node scripts/audit-lobby-roundtrips.mjs
import { createFakeSupabase } from '../src/testUtils/fakeSupabase.js';
import { createRoom, joinRoom, setReady, getRoom, setZodiac } from '../src/api/controllers/room.controller.js';

// Each `.from(table)` starts exactly one PostgREST request.
function countingSupabase() {
  const inner = createFakeSupabase();
  const calls = [];
  return {
    calls,
    client: {
      from(table) {
        calls.push(table);
        return inner.from(table);
      },
    },
  };
}

function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
}

function mockReq(supabase, { user, params = {}, body = {} }) {
  return {
    params, body, user,
    app: { get: (k) => (k === 'supabase' ? supabase : undefined) },
  };
}

async function run(label, supabase, calls, fn) {
  const before = calls.length;
  await fn();
  const used = calls.slice(before);
  console.log(`${label.padEnd(34)} ${String(used.length).padStart(2)} round trips  [${used.join(', ')}]`);
  return used.length;
}

const { client: supabase, calls } = countingSupabase();

console.log('Supabase round trips per lobby action (4-player room)\n');

let room;
await run('createRoom (host)', supabase, calls, async () => {
  const res = mockRes();
  await createRoom(mockReq(supabase, { user: { id: 'u0' } }), res);
  room = res.body;
});

for (const uid of ['u1', 'u2', 'u3']) {
  await run(`joinRoom (${uid})`, supabase, calls, async () => {
    const res = mockRes();
    await joinRoom(mockReq(supabase, { user: { id: uid }, params: { code: room.joinCode } }), res);
  });
}

const total = await run('setReady (one player toggles)', supabase, calls, async () => {
  const res = mockRes();
  await setReady(mockReq(supabase, { user: { id: 'u1' }, params: { id: room.roomId }, body: { ready: true } }), res);
  if (res.statusCode !== 200) throw new Error('setReady failed: ' + JSON.stringify(res.body));
});

await run('setZodiac (one player picks)', supabase, calls, async () => {
  const res = mockRes();
  await setZodiac(mockReq(supabase, { user: { id: 'u1' }, params: { id: room.roomId }, body: { zodiac: 'ty' } }), res);
});

const perRefresh = await run('getRoom (every poll / push refresh)', supabase, calls, async () => {
  const res = mockRes();
  await getRoom(mockReq(supabase, { user: { id: 'u1' }, params: { id: room.roomId } }), res);
});

console.log('\nAt ~180ms per Oregon<->Supabase round trip:');
console.log(`  one ready click  ≈ ${(total * 180 / 1000).toFixed(2)}s of database wait`);
console.log(`  one roster refresh ≈ ${(perRefresh * 180 / 1000).toFixed(2)}s, paid by EVERY client on EVERY poll tick`);
