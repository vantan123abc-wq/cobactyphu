// Singleton Supabase client — service_role, per API_CONTRACT.md: "every
// endpoint... implemented by the Express backend using service_role, doing
// its own membership/authorization checks in code, not by the client
// querying Supabase directly under RLS."
//
// No live Supabase project is reachable in this environment right now
// (PROJECT_STATUS.md: "No Supabase CLI, no DB password, no service_role
// key exist anywhere in this environment or project"). Exporting `null`
// when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY aren't both set — rather
// than calling createClient() with undefined values (which throws) or
// letting that throw crash this module's own import — is deliberate: this
// backend's server must still start and serve its non-DB-dependent routes
// without a live project, same "gracefully unavailable, not a crash"
// posture app.js's jwtSecret and infrastructure/websocket/socketServer.js's
// board-tile loading already use. Every consumer must treat `supabase` as
// possibly null, not assume a live client exists.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase = url && serviceRoleKey ? createClient(url, serviceRoleKey) : null;
