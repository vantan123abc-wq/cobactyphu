-- CoBacTyPhu — Core table migration (P02-T01)
-- Source of truth: docs/DATABASE_DESIGN.md §1-§13.
-- Local artifact only. NOT applied to any database by this task — see
-- IMPLEMENTATION_PLAN.md P02-T01 and the P02-T01 approval thread for why.
--
-- Approved design decisions this migration implements exactly as documented:
--   1. boards/board_tiles live in Postgres (driven by the original request that
--      created DATABASE_DESIGN.md, not a later addition).
--   2. game_state_snapshots keeps only the latest snapshot per game — PK is
--      game_id itself, no surrogate id, no history retention.
--   3. game_transactions uses the two-sided from/to shape with a strictly
--      positive amount, not a signed amount + nullable counterparty.
--   4. TEXT + CHECK is used instead of native Postgres ENUM types throughout.
--
-- Documented assumptions (per the task's own instruction to document rather
-- than silently introduce infrastructure):
--   - gen_random_uuid() is used for every UUID PK default. This is a native
--     Postgres 13+ built-in (no `pgcrypto` extension required); Supabase's
--     hosted Postgres is well past that version, so no CREATE EXTENSION
--     statement is included or needed.
--   - Every table gets `ENABLE ROW LEVEL SECURITY` at the end of this file.
--     No POLICY statements are included — that's P02-T02, a separate task.
--     Until those policies exist, this means the tables are unreachable by
--     any role except service_role (which bypasses RLS by definition) —
--     correct default-deny behavior, not a gap this migration should paper
--     over by leaving RLS off.
--   - No trigger populates `profiles` from `auth.users` in this file — that
--     auto-creation trigger is P03-T01 (Authentication phase), not this task.
--   - This file assumes the migration runner (e.g. `supabase db push`) wraps
--     it in its own transaction; no explicit BEGIN/COMMIT is added here to
--     avoid conflicting with that.
--
-- Table creation order below follows strict foreign-key dependency order —
-- every table only references a table already created earlier in this file.


-- ============================================================
-- 1. profiles  (DATABASE_DESIGN.md §1)
-- Extends auth.users (Supabase-managed) — never duplicated, only extended.
-- ============================================================
CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);


-- ============================================================
-- 6. boards  (DATABASE_DESIGN.md §6)
-- Fixed reference table — exactly 2 rows ('small','large'), seed data,
-- not written to at runtime. No dependencies, created early.
-- ============================================================
CREATE TABLE boards (
  id text PRIMARY KEY CHECK (id IN ('small', 'large')),
  name text NOT NULL,
  tile_count smallint NOT NULL CHECK (tile_count IN (36, 44)),
  min_players smallint NOT NULL,
  max_players smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);


-- ============================================================
-- 2. rooms  (DATABASE_DESIGN.md §2)
-- ============================================================
CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  join_code text NOT NULL CHECK (length(join_code) = 6),
  host_id uuid NOT NULL REFERENCES profiles(id),
  status text NOT NULL DEFAULT 'waiting_for_players'
    CHECK (status IN ('waiting_for_players', 'ready_check', 'starting', 'in_progress', 'abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Partial unique index: a join code can be reused once its room is no longer active.
CREATE UNIQUE INDEX rooms_join_code_active_idx ON rooms (join_code) WHERE status <> 'abandoned';
CREATE INDEX rooms_host_id_idx ON rooms (host_id);
CREATE INDEX rooms_status_idx ON rooms (status);

-- rooms.updated_at is bumped by trigger, per DATABASE_DESIGN.md §2.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rooms_set_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 7. board_tiles  (DATABASE_DESIGN.md §7)
-- Static per-board reference data — the tile *type system*, not live ownership.
-- ============================================================
CREATE TABLE board_tiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id text NOT NULL REFERENCES boards(id),
  "position" smallint NOT NULL,
  tile_type text NOT NULL
    CHECK (tile_type IN ('go', 'property', 'transport', 'utility', 'chance', 'fortune', 'tax', 'jail', 'free_parking', 'go_to_jail')),
  name text NOT NULL,
  group_id text,
  price integer,
  base_rent integer,
  rent_table jsonb,
  house_cost integer,
  mortgage_value integer,
  tax_amount integer,
  UNIQUE (board_id, "position")
);


-- ============================================================
-- 3. room_players  (DATABASE_DESIGN.md §3)
-- ============================================================
CREATE TABLE room_players (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES profiles(id),
  is_ready boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, player_id)
);

CREATE INDEX room_players_player_id_idx ON room_players (player_id);


-- ============================================================
-- 4. games  (DATABASE_DESIGN.md §4)
-- ============================================================
CREATE TABLE games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL UNIQUE REFERENCES rooms(id),
  board_id text NOT NULL REFERENCES boards(id),
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'ending', 'finished', 'aborted')),
  -- current_turn_index / state_version are denormalized, snapshot-cadence
  -- fields (DATABASE_DESIGN.md §4) — not updated on every single action.
  current_turn_index smallint NOT NULL DEFAULT 0,
  state_version bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE INDEX games_status_idx ON games (status);


-- ============================================================
-- 5. game_players  (DATABASE_DESIGN.md §5)
-- Includes a Bank sentinel row per game — player_id is null only for it.
-- ============================================================
CREATE TABLE game_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id uuid REFERENCES profiles(id),
  is_bank boolean NOT NULL DEFAULT false,
  turn_order smallint,
  starting_balance integer,
  -- current_balance/current_position/in_jail/jail_turns/bankrupt are
  -- denormalized, snapshot-cadence fields — true source of truth is always
  -- SUM(game_transactions) for this row (DATABASE_DESIGN.md §5).
  -- No DDL-level DEFAULT: initial value (= starting_balance, or
  -- BANK_RESERVE_INITIAL for the Bank row) is set by application code at
  -- insert time, since a column DEFAULT cannot reference a sibling column.
  current_balance integer NOT NULL,
  current_position smallint DEFAULT 0,
  in_jail boolean DEFAULT false,
  jail_turns smallint DEFAULT 0,
  bankrupt boolean DEFAULT false,
  bankrupt_at timestamptz,
  final_rank smallint,
  CHECK ((is_bank AND player_id IS NULL) OR (NOT is_bank AND player_id IS NOT NULL)),
  CHECK (current_balance >= 0 OR is_bank)
);

-- A real player appears once per game; the Bank sentinel is exempt (its
-- player_id is null, so it wouldn't collide anyway — this makes the intent explicit).
CREATE UNIQUE INDEX game_players_game_player_unique_idx ON game_players (game_id, player_id) WHERE NOT is_bank;
CREATE INDEX game_players_player_id_idx ON game_players (player_id);
CREATE INDEX game_players_game_id_turn_order_idx ON game_players (game_id, turn_order);


-- ============================================================
-- 8. properties  (DATABASE_DESIGN.md §8)
-- Per-game dynamic ownership — one row per property-type tile, created when
-- a game reaches STARTING. Written live, not snapshot-cadence.
-- ============================================================
CREATE TABLE properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  board_tile_id uuid NOT NULL REFERENCES board_tiles(id),
  owner_id uuid REFERENCES game_players(id),
  upgrade_level smallint NOT NULL DEFAULT 0 CHECK (upgrade_level BETWEEN 0 AND 5),
  mortgaged boolean NOT NULL DEFAULT false,
  acquired_at timestamptz,
  UNIQUE (game_id, board_tile_id)
);

CREATE INDEX properties_owner_id_idx ON properties (owner_id);


-- ============================================================
-- 9. game_state_snapshots ("Game State")  (DATABASE_DESIGN.md §9)
-- Approved decision 2: latest snapshot only. game_id IS the primary key —
-- no surrogate id, one row per game, written via UPSERT by the application.
-- ============================================================
CREATE TABLE game_state_snapshots (
  game_id uuid PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  state jsonb NOT NULL,
  reason text NOT NULL CHECK (reason IN ('turn_end', 'bankruptcy', 'game_over')),
  created_at timestamptz NOT NULL DEFAULT now()
);


-- ============================================================
-- 10. game_actions  (DATABASE_DESIGN.md §10)
-- Technical audit trail and durable idempotency backstop.
-- ============================================================
CREATE TABLE game_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id uuid REFERENCES game_players(id),
  client_action_id uuid,
  state_version bigint NOT NULL,
  action_type text NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enforces the monotonic-counter invariant at the DB level, not just in application logic.
CREATE UNIQUE INDEX game_actions_game_state_version_idx ON game_actions (game_id, state_version);
-- Durable idempotency backstop even if the in-memory dedup cache misses one.
CREATE UNIQUE INDEX game_actions_client_action_id_idx ON game_actions (game_id, client_action_id) WHERE client_action_id IS NOT NULL;
CREATE INDEX game_actions_game_id_created_at_idx ON game_actions (game_id, created_at);


-- ============================================================
-- 11. game_events  (DATABASE_DESIGN.md §11)
-- Narrative/notable-occurrence log — a curated subset of game_actions.
-- ============================================================
CREATE TABLE game_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  triggered_by_action_id uuid REFERENCES game_actions(id),
  event_type text NOT NULL,
  player_id uuid REFERENCES game_players(id),
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX game_events_game_id_created_at_idx ON game_events (game_id, created_at);


-- ============================================================
-- 12. game_transactions  (DATABASE_DESIGN.md §12)
-- Approved decision 3: two-sided from/to shape, amount always positive.
-- Every row is a complete, atomic transfer — structurally impossible to
-- represent a non-balanced transaction, which is what makes
-- ECONOMY_SPECIFICATION.md §4's invariant provable by the schema itself.
-- ============================================================
CREATE TABLE game_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  from_game_player_id uuid NOT NULL REFERENCES game_players(id),
  to_game_player_id uuid NOT NULL REFERENCES game_players(id),
  amount integer NOT NULL CHECK (amount > 0),
  transaction_type text NOT NULL CHECK (transaction_type IN (
    'initial_balance', 'purchase', 'rent', 'pass_go_salary', 'tax',
    'event_card', 'jail_fine', 'build', 'sell_house', 'mortgage',
    'unmortgage', 'trade', 'flash_auction', 'hostile_acquisition',
    'rent_gamble', 'bankruptcy_transfer'
  )),
  idempotency_key text NOT NULL,
  -- Denormalized audit convenience, computed by the backend at write time —
  -- not a second source of truth. True balance is always SUM(this table).
  resulting_balance_from integer,
  resulting_balance_to integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_game_player_id <> to_game_player_id),
  UNIQUE (idempotency_key)
);

CREATE INDEX game_transactions_game_id_created_at_idx ON game_transactions (game_id, created_at);
CREATE INDEX game_transactions_from_game_player_id_idx ON game_transactions (from_game_player_id);
CREATE INDEX game_transactions_to_game_player_id_idx ON game_transactions (to_game_player_id);


-- ============================================================
-- 13. match_results  (DATABASE_DESIGN.md §13)
-- Deliberately not a standings JSONB blob — per-player standings already
-- live properly normalized in game_players (final_rank, current_balance,
-- bankrupt_at). This table only records the match outcome itself.
-- ============================================================
CREATE TABLE match_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL UNIQUE REFERENCES games(id),
  result_type text NOT NULL CHECK (result_type IN ('elimination_win', 'net_worth_win', 'aborted')),
  winner_game_player_id uuid REFERENCES game_players(id),
  ended_at timestamptz NOT NULL DEFAULT now()
);


-- ============================================================
-- Row Level Security: enabled on every table, no policies yet (P02-T02).
-- Until policies exist, every table is reachable only by service_role,
-- which bypasses RLS by definition — correct default-deny, not a gap.
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_tiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_state_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_results ENABLE ROW LEVEL SECURITY;
