-- Lovable Cloud grants anon explicitly at function creation; revoking PUBLIC alone is insufficient.
begin;
revoke all on function public.feed_normalize_topics(jsonb, integer) from public, anon, authenticated;
revoke all on function public.apply_feed_preference_command(text, jsonb) from public, anon;
revoke all on function public.undo_feed_preference_change(uuid) from public, anon;
revoke all on function public.feed_explicit_preference_scores(uuid[]) from public, anon;
grant execute on function public.apply_feed_preference_command(text, jsonb) to authenticated;
grant execute on function public.undo_feed_preference_change(uuid) to authenticated;
grant execute on function public.feed_explicit_preference_scores(uuid[]) to authenticated;
commit;
