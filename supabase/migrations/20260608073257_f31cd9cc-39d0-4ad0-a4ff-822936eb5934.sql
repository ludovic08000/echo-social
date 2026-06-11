
-- 1) anonymous_wall_messages.author_id : ne doit jamais être lu côté client
REVOKE SELECT (author_id) ON public.anonymous_wall_messages FROM anon, authenticated;

-- 2) live_streams.stream_key : déjà revoked, on rejoue pour être sûr
DO $$ BEGIN
  EXECUTE 'REVOKE SELECT (stream_key) ON public.live_streams FROM anon, authenticated';
EXCEPTION WHEN undefined_column THEN NULL; END $$;

-- 3) profiles.phone_number / date_of_birth : revoked from anon + authenticated
DO $$ BEGIN
  EXECUTE 'REVOKE SELECT (phone_number) ON public.profiles FROM anon, authenticated';
EXCEPTION WHEN undefined_column THEN NULL; END $$;
DO $$ BEGIN
  EXECUTE 'REVOKE SELECT (date_of_birth) ON public.profiles FROM anon, authenticated';
EXCEPTION WHEN undefined_column THEN NULL; END $$;
