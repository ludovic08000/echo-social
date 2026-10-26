begin;
alter table public.posts add column if not exists subscriber_only boolean not null default false;
revoke insert,update,delete on public.fan_subscriptions from public,anon,authenticated;
create index if not exists fan_active_access_lookup on public.fan_subscriptions(creator_id,fan_id,current_period_end) where status='active';

create function public.social_post_access_internal(p_post_id uuid,p_viewer_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.posts p left join public.privacy_settings s on s.user_id=p.user_id
    where p.id=p_post_id and (
      p.user_id=p_viewer_id or (
        (p.publish_at is null or p.publish_at<=now()) and (p.expires_at is null or p.expires_at>now())
        and not exists(select 1 from public.user_message_blocks b where
          (b.blocker_user_id=p_viewer_id and b.blocked_user_id=p.user_id)
          or (b.blocker_user_id=p.user_id and b.blocked_user_id=p_viewer_id))
        and (coalesce(s.profile_visibility,'public')='public' or (s.profile_visibility='friends' and exists(
          select 1 from public.friendships f where f.status='accepted' and
          ((f.requester_id=p_viewer_id and f.addressee_id=p.user_id) or (f.addressee_id=p_viewer_id and f.requester_id=p.user_id)))))
        and (coalesce(s.posts_visibility,'public')='public' or (s.posts_visibility='friends' and exists(
          select 1 from public.friendships f where f.status='accepted' and
          ((f.requester_id=p_viewer_id and f.addressee_id=p.user_id) or (f.addressee_id=p_viewer_id and f.requester_id=p.user_id)))))
        and (not coalesce(p.subscriber_only,false) or exists(select 1 from public.fan_subscriptions f
          where f.creator_id=p.user_id and f.fan_id=p_viewer_id and f.status='active'
          and (f.current_period_end is null or f.current_period_end>now())))
      )
    ));
$$;
revoke all on function public.social_post_access_internal(uuid,uuid) from public,anon,authenticated;
create function public.can_read_social_post(p_post_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select public.social_post_access_internal(p_post_id,(select auth.uid()));
$$;
revoke all on function public.can_read_social_post(uuid) from public;
grant execute on function public.can_read_social_post(uuid) to anon,authenticated,service_role;
create policy "Post access invariant" on public.posts as restrictive for select to anon,authenticated
  using(public.can_read_social_post(id));

create function public.my_seller_profile() returns jsonb language sql stable security definer set search_path='' as $$
  select to_jsonb(s) from public.seller_profiles s where s.user_id=(select auth.uid());
$$;
revoke all on function public.my_seller_profile() from public,anon;
grant execute on function public.my_seller_profile() to authenticated;

CREATE OR REPLACE FUNCTION public.feed_eligible_post_ids_internal(
  p_viewer_id uuid,
  p_post_ids uuid[]
)
RETURNS TABLE (post_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT post.id
  FROM public.posts AS post
  JOIN public.profiles AS profile
    ON profile.user_id = post.user_id
  LEFT JOIN public.privacy_settings AS privacy
    ON privacy.user_id = post.user_id
  LEFT JOIN public.user_feed_preferences AS preference
    ON preference.user_id = p_viewer_id
  LEFT JOIN public.ml_post_features AS feature
    ON feature.post_id = post.id
  LEFT JOIN public.parental_controls AS viewer_parental
    ON viewer_parental.user_id = p_viewer_id
   AND viewer_parental.is_active = true
   AND viewer_parental.is_minor = true
  WHERE p_post_ids IS NOT NULL
      AND post.id = ANY(p_post_ids)
      -- Le feed applique deja visibilite/blocages/dates ci-dessous ; verifier aussi le droit fan sans relire chaque post.
      AND (NOT COALESCE(post.subscriber_only,false) OR post.user_id=p_viewer_id OR EXISTS (
        SELECT 1 FROM public.fan_subscriptions subscription
        WHERE subscription.creator_id=post.user_id AND subscription.fan_id=p_viewer_id
          AND subscription.status='active'
          AND (subscription.current_period_end IS NULL OR subscription.current_period_end>now())
      ))
      AND (post.publish_at IS NULL OR post.publish_at <= now())
      AND (post.expires_at IS NULL OR post.expires_at > now())
      AND (
        post.user_id = p_viewer_id
        OR COALESCE(privacy.profile_visibility, 'public') = 'public'
        OR (privacy.profile_visibility = 'friends' AND EXISTS (
          SELECT 1 FROM public.friendships f WHERE f.status = 'accepted'
          AND ((f.requester_id = p_viewer_id AND f.addressee_id = post.user_id)
            OR (f.addressee_id = p_viewer_id AND f.requester_id = post.user_id))
        ))
      )
      AND (
        post.user_id = p_viewer_id
        OR COALESCE(privacy.posts_visibility, 'public') = 'public'
        OR (
          COALESCE(privacy.posts_visibility, 'public') = 'friends'
          AND p_viewer_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.friendships AS friendship
            WHERE friendship.status = 'accepted'
              AND (
                (friendship.requester_id = p_viewer_id AND friendship.addressee_id = post.user_id)
                OR
                (friendship.addressee_id = p_viewer_id AND friendship.requester_id = post.user_id)
              )
          )
        )
      )
      AND (
        p_viewer_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.user_message_blocks AS user_block
          WHERE
            (user_block.blocker_user_id = p_viewer_id AND user_block.blocked_user_id = post.user_id)
            OR
            (user_block.blocker_user_id = post.user_id AND user_block.blocked_user_id = p_viewer_id)
        )
      )
      AND (
        p_viewer_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.ml_interactions AS exclusion
          WHERE exclusion.user_id = p_viewer_id
            AND exclusion.post_id = post.id
            AND exclusion.signal_type IN ('hide', 'not_interested', 'report')
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(COALESCE(preference.muted_keywords, ARRAY[]::text[])) AS muted(keyword)
        WHERE muted.keyword <> ''
          AND strpos(lower(COALESCE(post.body, '')), lower(muted.keyword)) > 0
      )
      AND (
        NOT COALESCE(preference.sensitive_content_filter, true)
        OR COALESCE(feature.content_sensitivity_score, 0) <= 0.5
      )
      AND (
        viewer_parental.user_id IS NULL
        OR (
          COALESCE(feature.content_sensitivity_score, 0) <= 0.35
          AND public.parental_content_category_allowed(
            post.body,
            feature.topics,
            feature.hashtags,
            viewer_parental.allowed_categories
          )
        )
      )
      AND (
        NOT COALESCE(preference.seen_posts_hide, false)
        OR p_viewer_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.ml_interactions AS seen
          WHERE seen.user_id = p_viewer_id
            AND seen.post_id = post.id
            AND seen.signal_type IN ('view', 'dwell_medium', 'dwell_long', 'watch_complete')
        )
      );
$function$;

commit;
