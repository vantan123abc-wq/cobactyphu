-- Zodiac (12 con giáp) player-piece picker (2026-08-22) — a lobby-time
-- choice, needs to be visible to every other player before the match
-- starts, so it lives on `room_players`, not something invented client-side
-- only. Nullable with no default: every existing row stays valid without
-- backfilling (null = "hasn't chosen yet", which room.controller.js's
-- initializeGameState() resolves to a random pick at game start — see that
-- function's own header). Duplicates across players in the same room are
-- deliberately allowed (colour, not the animal, is what makes two players
-- distinguishable) — no UNIQUE constraint.
--
-- The 12 valid keys are domain/zodiac.js's own ZODIAC_KEYS, kept in sync by
-- hand (same standing as every other enum this project maintains on both
-- sides of the frontend/backend boundary, e.g. game_transactions.transaction_type
-- vs. economy/applyTransaction.js's TRANSACTION_TYPES) — not selected from a
-- shared source, since Postgres CHECK constraints can't import a JS module.
ALTER TABLE room_players ADD COLUMN zodiac text;

ALTER TABLE room_players ADD CONSTRAINT room_players_zodiac_check
  CHECK (zodiac IS NULL OR zodiac IN (
    'ty', 'suu', 'dan', 'mao', 'thin', 'ty2',
    'ngo', 'mui', 'than', 'dau', 'tuat', 'hoi'
  ));
