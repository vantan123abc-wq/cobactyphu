-- Backfill profiles cho tất cả auth.users chưa có profiles row
INSERT INTO public.profiles (id, display_name, avatar_url, created_at)
SELECT
  u.id,
  COALESCE(
    u.raw_user_meta_data->>'display_name',
    split_part(u.email, '@', 1)
  ),
  NULL,
  NOW()
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.profiles p WHERE p.id = u.id
)
RETURNING id, display_name;
