
-- 1. PROFILES: Secure view hiding sensitive fields from non-owners
CREATE OR REPLACE VIEW public.profiles_public AS
SELECT 
  user_id, name, avatar_url, bio, city, profile_type, mood_emoji,
  age_verified, profile_music_url,
  onboarding_completed, created_at, updated_at,
  CASE WHEN auth.uid() = user_id THEN phone_number ELSE NULL END AS phone_number,
  CASE WHEN auth.uid() = user_id THEN date_of_birth ELSE NULL END AS date_of_birth
FROM public.profiles;

-- 2. TRUST SCORES: Fix privilege escalation
DROP POLICY IF EXISTS "System can manage trust scores" ON public.trust_scores;

CREATE POLICY "Users can only update own trust score"
ON public.trust_scores FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- 3. NOTIFICATIONS: Remove overly permissive INSERT
DROP POLICY IF EXISTS "Authenticated users can create notifications" ON public.notifications;

-- 4. AI LEARNED RULES: Restrict to admins
DROP POLICY IF EXISTS "System can insert rules" ON public.ai_learned_rules;

CREATE POLICY "Only admins can insert AI rules"
ON public.ai_learned_rules FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 5. ANONYMOUS WALL: View hiding author_id
CREATE OR REPLACE VIEW public.anonymous_wall_public AS
SELECT id, target_user_id, message, is_approved, created_at
FROM public.anonymous_wall_messages
WHERE is_approved = true;

-- 6. AI METRICS: Restrict to admins
DROP POLICY IF EXISTS "Authenticated users can read metrics" ON public.ai_metrics_log;

CREATE POLICY "Only admins can read AI metrics"
ON public.ai_metrics_log FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));
