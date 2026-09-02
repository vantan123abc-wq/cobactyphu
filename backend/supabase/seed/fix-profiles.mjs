// Backfill profiles for all auth.users without a profiles row
// Runs via: node --env-file=.env supabase/seed/fix-profiles.mjs
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

// 1. Get all auth users
const { data: users, error: usersErr } = await sb.auth.admin.listUsers()
if (usersErr) { console.error('Failed to list users:', usersErr.message); process.exit(1) }

console.log(`Found ${users.users.length} auth users`)

// 2. Get existing profiles
const { data: existing, error: profErr } = await sb.from('profiles').select('id')
if (profErr) { console.error('Failed to fetch profiles:', profErr.message); process.exit(1) }

const existingIds = new Set(existing.map(p => p.id))

// 3. Insert missing profiles
const missing = users.users.filter(u => !existingIds.has(u.id))
console.log(`Missing profiles: ${missing.length}`)

if (missing.length === 0) {
  console.log('✓ All users already have profiles — nothing to do')
  process.exit(0)
}

const rows = missing.map(u => ({
  id: u.id,
  display_name: u.user_metadata?.display_name ?? u.email.split('@')[0],
  avatar_url: null,
}))

const { data: inserted, error: insErr } = await sb.from('profiles').insert(rows).select('id, display_name')
if (insErr) { console.error('Insert failed:', insErr.message); process.exit(1) }

console.log('✓ Created profiles:')
inserted.forEach(p => console.log(`  ${p.id} → ${p.display_name}`))
