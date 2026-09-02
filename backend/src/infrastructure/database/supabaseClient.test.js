import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from './supabaseClient.js';

// This project's real, current state: no SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// exist anywhere in this environment (PROJECT_STATUS.md). This test asserts
// exactly that — importing this module must not throw, and must expose
// `null` rather than a half-configured client — since the whole point of
// the null-fallback design is that this is the actual path being exercised
// every time this backend runs here today, not a hypothetical edge case.
test('supabase is null when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are unset (this project\'s current real state)', () => {
  assert.equal(process.env.SUPABASE_URL, undefined);
  assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(supabase, null);
});
