-- Reconciles real schema drift found live 2026-09-05: migration 0005's own
-- `zodiac` COLUMN already existed on the production database — a real
-- `db push` attempt failed with "column already exists" (SQLSTATE 42701) —
-- even though this project's migration history table had no record of 0005
-- ever running. Someone applied it out-of-band (the same
-- "npx supabase db query --file ... --linked" technique this project's own
-- history already used once for boards.sql), never through the tracked
-- migration flow, so the history and the real schema disagreed.
--
-- 0005's history entry was repaired (marked applied) once the column's
-- existence was confirmed directly, but that only proves the COLUMN made it
-- out-of-band — 0005's own CHECK constraint (`room_players_zodiac_check`)
-- was never independently verified, since the db-push attempt aborted at
-- the column statement before ever reaching it. Guarded here rather than
-- assumed either way: a safe no-op if the out-of-band change happened to
-- include the constraint too, and a real fix if it did not — the one gap
-- that would otherwise let an invalid zodiac value be written with nothing
-- to stop it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'room_players_zodiac_check'
  ) THEN
    ALTER TABLE room_players ADD CONSTRAINT room_players_zodiac_check
      CHECK (zodiac IS NULL OR zodiac IN (
        'ty', 'suu', 'dan', 'mao', 'thin', 'ty2',
        'ngo', 'mui', 'than', 'dau', 'tuat', 'hoi'
      ));
  END IF;
END $$;
