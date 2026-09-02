-- CoBacTyPhu — profiles auto-creation trigger (P03-T01, Artifact-Only)
-- Source of truth: docs/DATABASE_DESIGN.md §1, docs/IMPLEMENTATION_PLAN.md P03-T01.
-- Local artifact only. NOT applied to any database by this task — same
-- artifact-only pattern as 0001/0002 (no Supabase CLI/DB password/service_role
-- key available in this environment). Validated by manual review only.
--
-- This migration assumes 0001_core_tables.sql has already run (profiles must
-- exist first) and does not alter anything created by 0001 or 0002.
--
-- Documented assumptions (per this project's convention of stating rather
-- than silently relying on infrastructure — see 0002's own header):
--   - `auth.users` has a `raw_user_meta_data jsonb` column populated from
--     whatever is passed as `options.data` to `supabase.auth.signUp()` —
--     Supabase-provisioned, not created by this migration.
--
-- Signup metadata contract (confirmed by P03-T04,
-- frontend/src/features/auth/SignUpForm.jsx): supabase.auth.signUp() sends
-- options.data.display_name, so NEW.raw_user_meta_data->>'display_name' is
-- the key to read. That contract only holds for signups going through this
-- project's own form, though — auth.users rows created via OAuth, the
-- Supabase Dashboard, or any other future path may carry no such key, or an
-- empty one. Hence the fallback chain below, exactly as specified in
-- IMPLEMENTATION_PLAN.md P03-T01: "a sensible default display_name derived
-- from auth metadata (email local-part, or a placeholder)" — no other
-- fallback rule is used.


-- ============================================================
-- handle_new_user — inserts one profiles row for a newly-created auth.users
-- row. SECURITY DEFINER is required here for two independent reasons: (1) a
-- plain `authenticated`/`anon` role has no INSERT policy on profiles at all
-- (see 0002_rls_policies.sql's comment directly above profiles_update_own —
-- rows are created by this trigger, not by the client), and (2) the function
-- needs to read auth.users, a schema application roles don't own. Same
-- SECURITY DEFINER + SET search_path pattern already used for
-- is_room_member/is_game_member in 0002_rls_policies.sql, not a new one.
-- Must be plpgsql, not sql: trigger functions returning `trigger` and
-- referencing NEW require a procedural language.
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- COALESCE fallback chain (first non-null/non-blank wins):
  --   1. options.data.display_name, as sent by SignUpForm.jsx.
  --   2. The local part of the user's email (split on '@').
  --   3. A literal placeholder, for the residual case where neither exists
  --      (e.g. phone-only auth with no metadata).
  -- NULLIF(..., '') on the first two turns a blank/whitespace-only value
  -- into NULL so COALESCE correctly falls through instead of trying to
  -- insert a value that would fail profiles' own
  -- `CHECK (length(display_name) BETWEEN 1 AND 40)` constraint.
  INSERT INTO profiles (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(TRIM(NEW.raw_user_meta_data->>'display_name'), ''),
      NULLIF(SPLIT_PART(NEW.email, '@', 1), ''),
      'Player'
    )
  )
  -- Duplicate-safe: if this function is ever invoked more than once for the
  -- same auth.users row, the second attempt is a silent no-op rather than a
  -- unique-violation error, preserving "exactly one profiles row per user"
  -- without turning a legitimate failure into a swallowed one (there's no
  -- broad exception handler here on purpose — per IMPLEMENTATION_PLAN.md's
  -- own risk note, a genuine failure should still fail the signup
  -- transaction, since a user without a profile shouldn't exist).
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Canonical Supabase naming for this exact standard pattern (DATABASE_DESIGN.md
-- §1 calls it out by name), reused here rather than inventing a new one.
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();
