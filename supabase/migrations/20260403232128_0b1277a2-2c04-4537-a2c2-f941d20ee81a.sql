
-- Fix: only revoke on tables that exist (user_identity_keys doesn't exist)
-- The previous migration already revoked most tables but failed at user_identity_keys
-- So we only need to handle the remaining tables after that point

REVOKE ALL ON public.user_prekeys FROM anon;
REVOKE ALL ON public.user_signed_prekeys FROM anon;

REVOKE ALL ON public.creator_subscriptions FROM anon;
REVOKE ALL ON public.ad_campaigns FROM anon;
REVOKE ALL ON public.ad_daily_stats FROM anon;
REVOKE ALL ON public.ad_interactions FROM anon;
REVOKE ALL ON public.orders FROM anon;
REVOKE ALL ON public.order_items FROM anon;
REVOKE ALL ON public.cart_items FROM anon;
REVOKE ALL ON public.negotiations FROM anon;

REVOKE ALL ON public.email_send_log FROM anon;
REVOKE ALL ON public.email_send_state FROM anon;
REVOKE ALL ON public.email_unsubscribe_tokens FROM anon;

REVOKE ALL ON public.journal_entries FROM anon;
REVOKE ALL ON public.friend_groups FROM anon;
REVOKE ALL ON public.friend_group_members FROM anon;
REVOKE ALL ON public.anonymous_wall_messages FROM anon;
REVOKE ALL ON public.albums FROM anon;
REVOKE ALL ON public.album_media FROM anon;

REVOKE ALL ON public.user_roles FROM anon;
REVOKE ALL ON public.trust_scores FROM anon;

-- Grant back SELECT on public-facing tables
GRANT SELECT ON public.products TO anon;
GRANT SELECT ON public.seller_profiles TO anon;
GRANT SELECT ON public.product_reviews TO anon;
GRANT SELECT ON public.groups TO anon;
GRANT SELECT ON public.pages TO anon;
GRANT SELECT ON public.live_streams TO anon;
GRANT SELECT ON public.challenges TO anon;
GRANT SELECT ON public.ai_agents TO anon;
GRANT SELECT ON public.profiles_safe TO anon;
GRANT SELECT ON public.anonymous_wall_public TO anon;
