-- ASYMMETRIC ruleset (docs/ASYMMETRIC_MODE_SPEC.md) needs two ledger types
-- that 0001's original CHECK list never anticipated.
--
-- `movement_card_cost` is NOT new work — it closes a live bug. The mode's
-- movement cards have always been able to carry a cash cost, and
-- handlePlayMovementCard has always passed this exact string to
-- applyTransaction, but the string was in neither the CHECK constraint nor
-- economy/applyTransaction.js's TRANSACTION_TYPES. Playing any card with a
-- cost therefore threw instead of moving the player: 4 of the deck's 18 cards
-- (STEP_1/2/3 at $50, SPRINT_12 at $100).
--
-- `pass_through_toll` is the EXECUTION archetype's per-crossing charge
-- (§3.2): $75 per development level, paid by whoever drives past a developed
-- blue/darkblue tile. It is a real player-to-player transfer, not a Bank
-- payment, and it is settled one ledger row per tile crossed rather than one
-- aggregate row per move — a player crossing three developed tiles genuinely
-- paid three separate owners-or-amounts and the ledger should say so.
--
-- Same constraint-name lookup as 0004: Postgres' default naming for an
-- inline unnamed CHECK isn't guaranteed stable across versions/tooling, so
-- this resolves the real name instead of assuming it.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'game_transactions'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%transaction_type%';

  EXECUTE format('ALTER TABLE game_transactions DROP CONSTRAINT %I', constraint_name);

  ALTER TABLE game_transactions ADD CONSTRAINT game_transactions_transaction_type_check
    CHECK (transaction_type IN (
      'initial_balance', 'purchase', 'rent', 'pass_go_salary', 'tax',
      'event_card', 'jail_fine', 'build', 'sell_house', 'mortgage',
      'unmortgage', 'trade', 'flash_auction', 'hostile_acquisition',
      'rent_gamble', 'bankruptcy_transfer', 'free_parking_jackpot',
      'movement_card_cost', 'pass_through_toll'
    ));
END $$;
