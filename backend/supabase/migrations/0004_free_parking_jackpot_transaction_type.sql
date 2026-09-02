-- Phase 14 (2026-08-19): Free Parking jackpot payout needs its own ledger
-- type — GAME_DESIGN_SPEC.md §14's tax-jackpot variant, now confirmed
-- adopted (was `[OPEN DESIGN DECISION]`, default "disappears").
--
-- `hostile_acquisition`/`rent_gamble` (Phase 14's other two `[PROPOSED]`
-- mechanics from BOARD_SPECIFICATION.md Part 2) were already anticipated in
-- 0001_core_tables.sql's own transaction_type CHECK list from the start —
-- no migration needed for those, only this one is actually new.
--
-- The tax/jail-fine payments that *feed* the jackpot are unchanged real
-- Bank-directed transactions (still typed 'tax'/'jail_fine' — see
-- ECONOMY_SPECIFICATION.md's own guidance for this variant: "funded by a
-- real source... an accumulating pool of Tax/Fine payments the Bank
-- already collected", not a redirected destination). This new type is only
-- for the payout leg: Bank -> the player who lands on Free Parking while
-- gameState.freeParkingJackpot > 0.
--
-- Constraint name not hardcoded — Postgres' default naming for an inline,
-- unnamed single-column CHECK isn't guaranteed across every Postgres
-- version/tooling combination, so this looks the real name up rather than
-- assuming it.
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
      'rent_gamble', 'bankruptcy_transfer', 'free_parking_jackpot'
    ));
END $$;
