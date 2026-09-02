-- Delete broken rooms that have status = 'in_progress' but no game record
UPDATE public.rooms
SET status = 'abandoned'
WHERE status = 'in_progress'
  AND NOT EXISTS (
    SELECT 1 FROM public.games WHERE games.room_id = rooms.id
  );
