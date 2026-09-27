-- Protect profile privacy and server-owned account state at the database boundary.
-- Public clients retain access to explicitly public columns. Private fields and
-- all profile mutations are served by narrow, caller-bound RPCs.

CREATE OR REPLACE FUNCTION public.get_profile_for_viewer(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_viewer uuid := auth.uid();
  v_visibility jsonb;
  v_is_owner boolean := false;
  v_is_admin boolean := false;
  v_is_friend boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.*
    INTO v_profile
  FROM public.profiles AS p
  WHERE p.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_is_owner := v_viewer IS NOT NULL AND v_viewer = p_user_id;
  v_is_admin := v_viewer IS NOT NULL
    AND public.has_role(v_viewer, 'admin'::public.app_role);

  IF v_viewer IS NOT NULL AND NOT v_is_owner THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.friendships AS f
      WHERE f.status = 'accepted'
        AND (
          (f.requester_id = v_viewer AND f.addressee_id = p_user_id)
          OR (f.requester_id = p_user_id AND f.addressee_id = v_viewer)
        )
    ) INTO v_is_friend;
  END IF;

  v_visibility := COALESCE(
    v_profile.field_visibility,
    '{"city":"public","work":"public","education":"public","interests":"public","date_of_birth":"public","relationship_status":"public"}'::jsonb
  );

  RETURN pg_catalog.jsonb_build_object(
    'id', v_profile.id,
    'user_id', v_profile.user_id,
    'name', v_profile.name,
    'avatar_url', v_profile.avatar_url,
    'bio', v_profile.bio,
    'created_at', v_profile.created_at,
    'updated_at', v_profile.updated_at,
    'cover_url', v_profile.cover_url,
    'date_of_birth', CASE
      WHEN v_is_owner OR v_is_admin
        OR COALESCE(v_visibility ->> 'date_of_birth', 'public') = 'public'
        OR (
          COALESCE(v_visibility ->> 'date_of_birth', 'public') = 'friends'
          AND v_is_friend
        )
      THEN v_profile.date_of_birth
      ELSE NULL
    END,
    'city', CASE
      WHEN v_is_owner OR v_is_admin
        OR COALESCE(v_visibility ->> 'city', 'public') = 'public'
        OR (
          COALESCE(v_visibility ->> 'city', 'public') = 'friends'
          AND v_is_friend
        )
      THEN v_profile.city
      ELSE NULL
    END,
    'website_url', v_profile.website_url,
    'profile_type', v_profile.profile_type,
    'cover_position_y', v_profile.cover_position_y,
    'education_level', CASE
      WHEN v_is_owner OR v_is_admin
        OR COALESCE(v_visibility ->> 'education', 'public') = 'public'
        OR (
          COALESCE(v_visibility ->> 'education', 'public') = 'friends'
          AND v_is_friend
        )
      THEN v_profile.education_level
      ELSE NULL
    END,
    'education_city', CASE
      WHEN v_is_owner OR v_is_admin
        OR COALESCE(v_visibility ->> 'education', 'public') = 'public'
        OR (
          COALESCE(v_visibility ->> 'education', 'public') = 'friends'
          AND v_is_friend
        )
      THEN v_profile.education_city
      ELSE NULL
    END,
    'work', CASE
      WHEN v_is_owner OR v_is_admin
        OR COALESCE(v_visibility ->> 'work', 'public') = 'public'
        OR (
          COALESCE(v_visibility ->> 'work', 'public') = 'friends'
          AND v_is_friend
        )
      THEN v_profile.work
      ELSE NULL
    END,
    'field_visibility', v_visibility,
    'relationship_status', CASE
      WHEN v_is_owner OR v_is_admin
        OR COALESCE(v_visibility ->> 'relationship_status', 'public') = 'public'
        OR (
          COALESCE(v_visibility ->> 'relationship_status', 'public') = 'friends'
          AND v_is_friend
        )
      THEN v_profile.relationship_status
      ELSE NULL
    END,
    'interests', CASE
      WHEN v_is_owner OR v_is_admin
        OR COALESCE(v_visibility ->> 'interests', 'public') = 'public'
        OR (
          COALESCE(v_visibility ->> 'interests', 'public') = 'friends'
          AND v_is_friend
        )
      THEN v_profile.interests
      ELSE NULL
    END,
    'mood_emoji', v_profile.mood_emoji,
    'mood_text', v_profile.mood_text,
    'mood_updated_at', v_profile.mood_updated_at,
    'profile_music_url', v_profile.profile_music_url,
    'is_creator', v_profile.is_creator,
    'creator_since', v_profile.creator_since,
    'creator_tier', v_profile.creator_tier,
    'profile_bg_url', v_profile.profile_bg_url,
    'feed_bg_url', CASE WHEN v_is_owner OR v_is_admin THEN v_profile.feed_bg_url ELSE NULL END,
    'age_verified', CASE WHEN v_is_owner OR v_is_admin THEN v_profile.age_verified ELSE false END,
    'age_verification_status', CASE
      WHEN v_is_owner OR v_is_admin THEN v_profile.age_verification_status
      ELSE 'none'
    END,
    'onboarding_completed', CASE
      WHEN v_is_owner OR v_is_admin THEN v_profile.onboarding_completed
      ELSE false
    END,
    'onboarding_step', CASE
      WHEN v_is_owner OR v_is_admin THEN v_profile.onboarding_step
      ELSE 0
    END
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_profile_for_viewer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_profile_for_viewer(uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_public_profile(profile_user_id uuid)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  name text,
  avatar_url text,
  bio text,
  mood_emoji text,
  is_creator boolean,
  creator_tier text,
  cover_url text,
  city text,
  country text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (profile ->> 'id')::uuid,
    (profile ->> 'user_id')::uuid,
    profile ->> 'name',
    profile ->> 'avatar_url',
    profile ->> 'bio',
    profile ->> 'mood_emoji',
    COALESCE((profile ->> 'is_creator')::boolean, false),
    profile ->> 'creator_tier',
    profile ->> 'cover_url',
    profile ->> 'city',
    NULL::text
  FROM (
    SELECT public.get_profile_for_viewer(profile_user_id) AS profile
  ) AS visible
  WHERE profile IS NOT NULL;
$$;

REVOKE EXECUTE ON FUNCTION public.get_public_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_profile(uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_own_profile(p_updates jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_patch public.profiles%ROWTYPE;
  v_key text;
  v_phone text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_updates IS NULL
     OR pg_catalog.jsonb_typeof(p_updates) <> 'object'
     OR p_updates = '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid profile update' USING ERRCODE = '22023';
  END IF;

  FOR v_key IN SELECT pg_catalog.jsonb_object_keys(p_updates)
  LOOP
    IF v_key NOT IN (
      'name', 'bio', 'avatar_url', 'cover_url', 'cover_position_y',
      'date_of_birth', 'city', 'website_url', 'education_level',
      'education_city', 'work', 'field_visibility', 'relationship_status',
      'interests', 'mood_emoji', 'mood_text', 'profile_music_url',
      'profile_bg_url', 'feed_bg_url', 'phone_number'
    ) THEN
      RAISE EXCEPTION 'profile field is not editable: %', v_key USING ERRCODE = '42501';
    END IF;
  END LOOP;

  v_patch := pg_catalog.jsonb_populate_record(NULL::public.profiles, p_updates);

  IF p_updates ? 'name'
     AND (v_patch.name IS NULL OR pg_catalog.length(pg_catalog.btrim(v_patch.name)) NOT BETWEEN 1 AND 80) THEN
    RAISE EXCEPTION 'invalid profile name' USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.length(COALESCE(v_patch.bio, '')) > 500
     OR pg_catalog.length(COALESCE(v_patch.city, '')) > 120
     OR pg_catalog.length(COALESCE(v_patch.website_url, '')) > 500
     OR pg_catalog.length(COALESCE(v_patch.education_level, '')) > 120
     OR pg_catalog.length(COALESCE(v_patch.education_city, '')) > 120
     OR pg_catalog.length(COALESCE(v_patch.work, '')) > 160
     OR pg_catalog.length(COALESCE(v_patch.relationship_status, '')) > 80
     OR pg_catalog.length(COALESCE(v_patch.mood_emoji, '')) > 16
     OR pg_catalog.length(COALESCE(v_patch.mood_text, '')) > 120
     OR pg_catalog.length(COALESCE(v_patch.avatar_url, '')) > 2048
     OR pg_catalog.length(COALESCE(v_patch.cover_url, '')) > 2048
     OR pg_catalog.length(COALESCE(v_patch.profile_music_url, '')) > 2048
     OR pg_catalog.length(COALESCE(v_patch.profile_bg_url, '')) > 2048
     OR pg_catalog.length(COALESCE(v_patch.feed_bg_url, '')) > 2048 THEN
    RAISE EXCEPTION 'profile value too long' USING ERRCODE = '22023';
  END IF;

  IF p_updates ? 'cover_position_y'
     AND (v_patch.cover_position_y IS NULL OR v_patch.cover_position_y NOT BETWEEN 0 AND 100) THEN
    RAISE EXCEPTION 'invalid cover position' USING ERRCODE = '22023';
  END IF;

  IF p_updates ? 'date_of_birth'
     AND v_patch.date_of_birth IS NOT NULL
     AND (v_patch.date_of_birth < DATE '1900-01-01' OR v_patch.date_of_birth > CURRENT_DATE) THEN
    RAISE EXCEPTION 'invalid date of birth' USING ERRCODE = '22023';
  END IF;

  IF p_updates ? 'interests' AND v_patch.interests IS NOT NULL THEN
    IF pg_catalog.cardinality(v_patch.interests) > 30
       OR EXISTS (
         SELECT 1 FROM pg_catalog.unnest(v_patch.interests) AS interest
         WHERE pg_catalog.length(interest) > 80
       ) THEN
      RAISE EXCEPTION 'invalid interests' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_updates ? 'field_visibility' THEN
    IF pg_catalog.jsonb_typeof(v_patch.field_visibility) <> 'object'
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_each_text(v_patch.field_visibility) AS entry(key, value)
         WHERE entry.key NOT IN (
           'city', 'work', 'education', 'interests',
           'date_of_birth', 'relationship_status'
         )
           OR entry.value NOT IN ('public', 'friends', 'only_me')
       ) THEN
      RAISE EXCEPTION 'invalid field visibility' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_updates ? 'phone_number' THEN
    IF v_patch.phone_number IS NULL OR pg_catalog.btrim(v_patch.phone_number) = '' THEN
      v_phone := NULL;
    ELSE
      v_phone := pg_catalog.regexp_replace(v_patch.phone_number, '[[:space:]().-]', '', 'g');
      IF pg_catalog.left(v_phone, 1) = '0' AND pg_catalog.length(v_phone) = 10 THEN
        v_phone := '+33' || pg_catalog.substr(v_phone, 2);
      ELSIF pg_catalog.left(v_phone, 1) <> '+' THEN
        v_phone := '+' || v_phone;
      END IF;

      IF v_phone !~ '^\+[1-9][0-9]{6,14}$' THEN
        RAISE EXCEPTION 'invalid phone number' USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  UPDATE public.profiles AS p
  SET
    name = CASE WHEN p_updates ? 'name' THEN pg_catalog.btrim(v_patch.name) ELSE p.name END,
    bio = CASE WHEN p_updates ? 'bio' THEN NULLIF(pg_catalog.btrim(v_patch.bio), '') ELSE p.bio END,
    avatar_url = CASE WHEN p_updates ? 'avatar_url' THEN NULLIF(pg_catalog.btrim(v_patch.avatar_url), '') ELSE p.avatar_url END,
    cover_url = CASE WHEN p_updates ? 'cover_url' THEN NULLIF(pg_catalog.btrim(v_patch.cover_url), '') ELSE p.cover_url END,
    cover_position_y = CASE WHEN p_updates ? 'cover_position_y' THEN v_patch.cover_position_y ELSE p.cover_position_y END,
    date_of_birth = CASE WHEN p_updates ? 'date_of_birth' THEN v_patch.date_of_birth ELSE p.date_of_birth END,
    city = CASE WHEN p_updates ? 'city' THEN NULLIF(pg_catalog.btrim(v_patch.city), '') ELSE p.city END,
    website_url = CASE WHEN p_updates ? 'website_url' THEN NULLIF(pg_catalog.btrim(v_patch.website_url), '') ELSE p.website_url END,
    education_level = CASE WHEN p_updates ? 'education_level' THEN NULLIF(pg_catalog.btrim(v_patch.education_level), '') ELSE p.education_level END,
    education_city = CASE WHEN p_updates ? 'education_city' THEN NULLIF(pg_catalog.btrim(v_patch.education_city), '') ELSE p.education_city END,
    work = CASE WHEN p_updates ? 'work' THEN NULLIF(pg_catalog.btrim(v_patch.work), '') ELSE p.work END,
    field_visibility = CASE WHEN p_updates ? 'field_visibility' THEN v_patch.field_visibility ELSE p.field_visibility END,
    relationship_status = CASE WHEN p_updates ? 'relationship_status' THEN NULLIF(pg_catalog.btrim(v_patch.relationship_status), '') ELSE p.relationship_status END,
    interests = CASE WHEN p_updates ? 'interests' THEN v_patch.interests ELSE p.interests END,
    mood_emoji = CASE WHEN p_updates ? 'mood_emoji' THEN NULLIF(pg_catalog.btrim(v_patch.mood_emoji), '') ELSE p.mood_emoji END,
    mood_text = CASE WHEN p_updates ? 'mood_text' THEN NULLIF(pg_catalog.btrim(v_patch.mood_text), '') ELSE p.mood_text END,
    mood_updated_at = CASE
      WHEN p_updates ? 'mood_emoji' OR p_updates ? 'mood_text' THEN pg_catalog.now()
      ELSE p.mood_updated_at
    END,
    profile_music_url = CASE WHEN p_updates ? 'profile_music_url' THEN NULLIF(pg_catalog.btrim(v_patch.profile_music_url), '') ELSE p.profile_music_url END,
    profile_bg_url = CASE WHEN p_updates ? 'profile_bg_url' THEN NULLIF(pg_catalog.btrim(v_patch.profile_bg_url), '') ELSE p.profile_bg_url END,
    feed_bg_url = CASE WHEN p_updates ? 'feed_bg_url' THEN NULLIF(pg_catalog.btrim(v_patch.feed_bg_url), '') ELSE p.feed_bg_url END,
    phone_number = CASE WHEN p_updates ? 'phone_number' THEN v_phone ELSE p.phone_number END,
    updated_at = pg_catalog.now()
  WHERE p.user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN public.get_profile_for_viewer(v_user_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_own_profile(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_own_profile(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_profiles(
  p_search text DEFAULT NULL,
  p_user_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  name text,
  avatar_url text,
  city text,
  bio text,
  created_at timestamp with time zone,
  profile_type text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role)
     AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'administrator required' USING ERRCODE = '42501';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100
     OR pg_catalog.length(COALESCE(p_search, '')) > 100
     OR COALESCE(pg_catalog.cardinality(p_user_ids), 0) > 100 THEN
    RAISE EXCEPTION 'invalid profile query' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT p.id, p.user_id, p.name, p.avatar_url, p.city, p.bio, p.created_at, p.profile_type
  FROM public.profiles AS p
  WHERE (p_search IS NULL OR p_search = '' OR p.name ILIKE '%' || p_search || '%')
    AND (p_user_ids IS NULL OR p.user_id = ANY(p_user_ids))
  ORDER BY p.created_at DESC
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_profile(
  p_user_id uuid,
  p_name text,
  p_city text,
  p_bio text,
  p_profile_type text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role)
     AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'administrator required' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL
     OR p_name IS NULL
     OR pg_catalog.length(pg_catalog.btrim(p_name)) NOT BETWEEN 1 AND 80
     OR pg_catalog.length(COALESCE(p_city, '')) > 120
     OR pg_catalog.length(COALESCE(p_bio, '')) > 500
     OR p_profile_type NOT IN ('user', 'creator') THEN
    RAISE EXCEPTION 'invalid profile update' USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles
  SET name = pg_catalog.btrim(p_name),
      city = NULLIF(pg_catalog.btrim(p_city), ''),
      bio = NULLIF(pg_catalog.btrim(p_bio), ''),
      profile_type = p_profile_type,
      updated_at = pg_catalog.now()
  WHERE user_id = p_user_id;

  RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_list_profiles(text, uuid[], integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_profile(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_profiles(text, uuid[], integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_profile(uuid, text, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.deactivate_own_creator_profile()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.creator_subscriptions
  SET status = 'cancelled',
      cancelled_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE user_id = v_user_id;

  UPDATE public.profiles
  SET is_creator = false,
      creator_tier = 'free',
      profile_type = 'user',
      updated_at = pg_catalog.now()
  WHERE user_id = v_user_id;

  RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.deactivate_own_creator_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deactivate_own_creator_profile() TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_own_identity_document(p_document_path text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_verification_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_document_path IS NULL
     OR pg_catalog.length(p_document_path) > 500
     OR p_document_path !~ ('^' || v_user_id::text || '/[A-Za-z0-9._-]+$')
     OR p_document_path LIKE '%..%' THEN
    RAISE EXCEPTION 'invalid document path' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM storage.objects AS obj
    WHERE obj.bucket_id = 'id-documents'
      AND obj.name = p_document_path
  ) THEN
    RAISE EXCEPTION 'identity document not found' USING ERRCODE = '22023';
  END IF;

  SELECT verification.id
    INTO v_verification_id
  FROM public.identity_verifications AS verification
  WHERE verification.reported_user_id = v_user_id
    AND verification.status IN ('pending', 'pending_verification', 'document_submitted')
  ORDER BY verification.created_at DESC
  LIMIT 1;

  IF v_verification_id IS NULL THEN
    RAISE EXCEPTION 'verification request not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.identity_verifications
  SET id_document_url = p_document_path,
      status = 'document_submitted',
      updated_at = pg_catalog.now()
  WHERE id = v_verification_id;

  UPDATE public.profiles
  SET age_verification_status = 'pending',
      updated_at = pg_catalog.now()
  WHERE user_id = v_user_id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_identity_verification(
  p_verification_id uuid,
  p_status text,
  p_admin_note text DEFAULT NULL,
  p_auto_deleted boolean DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reported_user_id uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role)
     AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'administrator required' USING ERRCODE = '42501';
  END IF;

  IF p_verification_id IS NULL
     OR p_status NOT IN (
       'pending', 'pending_verification', 'document_submitted',
       'verified', 'rejected', 'deleted'
     )
     OR pg_catalog.length(COALESCE(p_admin_note, '')) > 2000 THEN
    RAISE EXCEPTION 'invalid verification update' USING ERRCODE = '22023';
  END IF;

  UPDATE public.identity_verifications AS verification
  SET status = p_status,
      admin_note = CASE
        WHEN p_admin_note IS NOT NULL THEN p_admin_note
        ELSE verification.admin_note
      END,
      auto_deleted = CASE
        WHEN p_auto_deleted IS NOT NULL THEN p_auto_deleted
        ELSE verification.auto_deleted
      END,
      verified_at = CASE
        WHEN p_status = 'verified' THEN pg_catalog.now()
        ELSE verification.verified_at
      END,
      updated_at = pg_catalog.now()
  WHERE verification.id = p_verification_id
  RETURNING verification.reported_user_id INTO v_reported_user_id;

  IF v_reported_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF p_status = 'verified' THEN
    UPDATE public.profiles
    SET age_verified = true,
        age_verification_status = 'verified',
        updated_at = pg_catalog.now()
    WHERE user_id = v_reported_user_id;
  END IF;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_own_identity_document(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_identity_verification(uuid, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_own_identity_document(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_identity_verification(uuid, text, text, boolean) TO authenticated, service_role;

-- Direct Data API access is now limited to genuinely public profile columns.
-- RLS still controls rows, while column privileges prevent API callers from
-- requesting private or server-owned fields directly.
REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, user_id, name, avatar_url, bio, created_at, updated_at, cover_url,
  website_url, profile_type, cover_position_y, mood_emoji, mood_text,
  mood_updated_at, profile_music_url, is_creator, creator_since,
  creator_tier, profile_bg_url
) ON public.profiles TO anon, authenticated;

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
ON public.profiles
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Legacy views exposed internal state and are unused by the application.
REVOKE ALL PRIVILEGES ON TABLE public.profiles_public FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.profiles_safe FROM PUBLIC, anon, authenticated;

-- Users submit an object path through the guarded RPC; they cannot directly
-- promote a verification or write administrator-owned status fields.
REVOKE ALL PRIVILEGES ON TABLE public.identity_verifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.identity_verifications TO authenticated;
GRANT INSERT (reported_user_id, reporter_id, reason)
ON public.identity_verifications TO authenticated;
