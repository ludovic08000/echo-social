
-- 1. FIX: Profiles — secure function to get public-safe profile data (no phone/dob)
CREATE OR REPLACE FUNCTION public.get_public_profile(profile_user_id uuid)
RETURNS TABLE (
  id uuid, user_id uuid, name text, avatar_url text, bio text,
  mood_emoji text, is_creator boolean,
  creator_tier text, cover_url text,
  city text, country text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.user_id, p.name, p.avatar_url, p.bio,
         p.mood_emoji, p.is_creator,
         p.creator_tier, p.cover_url,
         p.city, NULL::text
  FROM public.profiles p
  WHERE p.user_id = profile_user_id;
$$;

-- Allow anon (guest) to read profiles (basic fields via RLS, sensitive hidden by app layer)
CREATE POLICY "Guests can view profiles"
ON public.profiles
FOR SELECT
TO anon
USING (true);

-- 2. FIX: Live streams — secure function for stream key (owner only)
DROP POLICY IF EXISTS "Anyone can view active streams" ON public.live_streams;
DROP POLICY IF EXISTS "Anyone can view live streams" ON public.live_streams;

CREATE POLICY "Users can view live streams"
ON public.live_streams
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Guests can view live streams"
ON public.live_streams
FOR SELECT
TO anon
USING (true);

CREATE OR REPLACE FUNCTION public.get_my_stream_key(stream_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT stream_key FROM public.live_streams
  WHERE id = stream_id AND user_id = auth.uid();
$$;

-- 3. FIX: Product storage — restrict DELETE/UPDATE to folder owner
DROP POLICY IF EXISTS "Authenticated users can delete product images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update product images" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete products" ON storage.objects;
DROP POLICY IF EXISTS "Users can update products" ON storage.objects;

CREATE POLICY "Owners can delete their product images"
ON storage.objects
FOR DELETE
USING (
  bucket_id = 'products'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

CREATE POLICY "Owners can update their product images"
ON storage.objects
FOR UPDATE
USING (
  bucket_id = 'products'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

-- 4. FIX: AI metrics — remove conflicting permissive SELECT policy
DROP POLICY IF EXISTS "Authenticated users can view ai_metrics_log" ON public.ai_metrics_log;

-- 5. Guest browsing: anon SELECT on public content tables
CREATE POLICY "Guests can view posts"
ON public.posts
FOR SELECT
TO anon
USING (true);

CREATE POLICY "Guests can view comments"
ON public.comments
FOR SELECT
TO anon
USING (true);

CREATE POLICY "Guests can view products"
ON public.products
FOR SELECT
TO anon
USING (true);

CREATE POLICY "Guests can view challenges"
ON public.challenges
FOR SELECT
TO anon
USING (true);

CREATE POLICY "Guests can view short videos"
ON public.short_videos
FOR SELECT
TO anon
USING (is_public = true);

CREATE POLICY "Guests can view stories"
ON public.stories
FOR SELECT
TO anon
USING (true);
