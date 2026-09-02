-- CoBacTyPhu — RLS policy migration (P02-T02, Artifact-Only)
-- Source of truth: docs/DATABASE_DESIGN.md § RLS strategy.
-- Local artifact only. NOT applied to any database by this task. Runtime
-- verification (negative-permission tests proving forbidden writes are
-- actually rejected by Postgres) is explicitly waived for this task and
-- deferred to a future environment-setup phase — see the P02-T02 approval
-- thread. This file is reviewable, not tested.
--
-- Core stance (unchanged from DATABASE_DESIGN.md): RLS here is a read-side
-- gate and a defense-in-depth backstop, not the primary write-authorization
-- mechanism. The backend writes every gameplay-relevant row using the
-- service_role key, which bypasses RLS by definition — service_role needs
-- no policies granting it anything. Everything below is about what an
-- `authenticated` client can read directly, plus the one narrow write
-- exception (profiles self-update).
--
-- Documented assumptions (per the task's instruction to state rather than
-- silently rely on infrastructure):
--   - `auth.uid()` is a Supabase-provided function returning the requesting
--     user's id from their verified JWT. Not vanilla Postgres — provisioned
--     automatically by Supabase, not created by this migration.
--   - `authenticated` and `service_role` are Supabase-provisioned Postgres
--     roles, same basis. No `anon`-role policies are added — every table
--     here requires a signed-in user at minimum.
--   - This migration assumes 0001_core_tables.sql has already run (every
--     table referenced below must exist first).
--
-- No INSERT/UPDATE/DELETE policy is written for the `authenticated` role on
-- any table except the one explicit exception (profiles). On a table with
-- RLS enabled, the *absence* of a policy for a given command already means
-- that command is denied for every role the policy doesn't name — no
-- explicit "deny" policies are needed to achieve that, and none are added.
--
-- Two SECURITY DEFINER helper functions (is_room_member, is_game_member)
-- are defined below, used only by room_players and game_players. Those two
-- tables' own membership check would otherwise require a self-referential
-- EXISTS subquery (querying room_players from inside room_players' own
-- policy) — a known risky pattern in Postgres RLS. SECURITY DEFINER changes
-- the execution context so the function's internal query isn't re-subject
-- to the calling policy the same way, avoiding that risk entirely. This is
-- Supabase's own recommended pattern for exactly this junction-table
-- scenario, not an invented workaround. Every other table's policy queries
-- game_players/room_players as a *different* table from itself, so it never
-- had this problem and is left exactly as-is.


-- ============================================================
-- profiles  — the one deliberate write exception.
-- Readable by any authenticated user (not secret — needed to show other
-- players' names/avatars). Writable only by the row's own owner.
-- ============================================================
CREATE POLICY profiles_select_any_authenticated
  ON profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY profiles_update_own
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
-- No INSERT policy: rows are created by the auth.users trigger (P03-T01),
-- not by the client directly. No DELETE policy: not a documented use case.


-- ============================================================
-- boards — fixed reference data, not secret, readable by any authenticated user.
-- ============================================================
CREATE POLICY boards_select_any_authenticated
  ON boards FOR SELECT
  TO authenticated
  USING (true);


-- ============================================================
-- board_tiles — same reasoning as boards.
-- ============================================================
CREATE POLICY board_tiles_select_any_authenticated
  ON board_tiles FOR SELECT
  TO authenticated
  USING (true);


-- ============================================================
-- rooms — member-scoped SELECT. Checks host_id OR room_players membership,
-- rather than assuming a host always also has a room_players row (that
-- sequencing isn't pinned down precisely enough elsewhere to rely on).
-- ============================================================
CREATE POLICY rooms_select_members
  ON rooms FOR SELECT
  TO authenticated
  USING (
    host_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM room_players
      WHERE room_players.room_id = rooms.id
        AND room_players.player_id = auth.uid()
    )
  );
-- Deliberately no policy allowing lookup by join_code — joining by code goes
-- through the backend (service_role) via POST /api/v1/rooms/:code/join,
-- exactly as API_CONTRACT.md specifies, so an authenticated client can't
-- probe/enumerate rooms by guessing codes directly against this table.


-- ============================================================
-- room_players — member-scoped SELECT via a SECURITY DEFINER helper
-- (see the note at the top of this file for why, not a raw self-join).
-- ============================================================
CREATE OR REPLACE FUNCTION is_room_member(target_room_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM room_players
    WHERE room_id = target_room_id
      AND player_id = auth.uid()
  );
$$;

CREATE POLICY room_players_select_members
  ON room_players FOR SELECT
  TO authenticated
  USING (is_room_member(room_id));


-- ============================================================
-- games — member-scoped SELECT via game_players.
-- ============================================================
CREATE POLICY games_select_members
  ON games FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM game_players
      WHERE game_players.game_id = games.id
        AND game_players.player_id = auth.uid()
    )
  );


-- ============================================================
-- game_players — member-scoped SELECT via a SECURITY DEFINER helper
-- (same reasoning as room_players above).
-- ============================================================
CREATE OR REPLACE FUNCTION is_game_member(target_game_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM game_players
    WHERE game_id = target_game_id
      AND player_id = auth.uid()
  );
$$;

CREATE POLICY game_players_select_members
  ON game_players FOR SELECT
  TO authenticated
  USING (is_game_member(game_id));


-- ============================================================
-- properties — member-scoped SELECT via game_players, through game_id.
-- ============================================================
CREATE POLICY properties_select_members
  ON properties FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM game_players
      WHERE game_players.game_id = properties.game_id
        AND game_players.player_id = auth.uid()
    )
  );


-- ============================================================
-- game_state_snapshots — NO policies at all, on purpose.
-- This table holds the full internal GameState recovery blob. Clients never
-- read it directly (they get state via game:state_update / GET
-- /api/v1/games/:id/state, both served by the backend using service_role) —
-- so unlike every other gameplay table, this one has no member-SELECT
-- policy either. RLS stays enabled from 0001; with zero policies for
-- `authenticated`, every operation on this table is denied to it, which is
-- the intended behavior, not an oversight.
-- ============================================================


-- ============================================================
-- game_actions — member-scoped SELECT via game_players, through game_id.
-- All participants can see all actions in a game they belong to (a shared
-- audit trail), not only their own.
-- ============================================================
CREATE POLICY game_actions_select_members
  ON game_actions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM game_players
      WHERE game_players.game_id = game_actions.game_id
        AND game_players.player_id = auth.uid()
    )
  );


-- ============================================================
-- game_events — same member-scoped pattern.
-- ============================================================
CREATE POLICY game_events_select_members
  ON game_events FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM game_players
      WHERE game_players.game_id = game_events.game_id
        AND game_players.player_id = auth.uid()
    )
  );


-- ============================================================
-- game_transactions — same member-scoped pattern. All participants can see
-- the full ledger for games they're in (supports a shared activity feed and
-- lets players verify fair play), not just transactions they were party to.
-- ============================================================
CREATE POLICY game_transactions_select_members
  ON game_transactions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM game_players
      WHERE game_players.game_id = game_transactions.game_id
        AND game_players.player_id = auth.uid()
    )
  );


-- ============================================================
-- match_results — same member-scoped pattern.
-- ============================================================
CREATE POLICY match_results_select_members
  ON match_results FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM game_players
      WHERE game_players.game_id = match_results.game_id
        AND game_players.player_id = auth.uid()
    )
  );
