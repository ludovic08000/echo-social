begin;

-- A restrictive SELECT policy is also evaluated by INSERT ... RETURNING.
-- Calling can_read_social_post(id) alone cannot see the row being inserted
-- through its STABLE helper snapshot. Author access must therefore be decided
-- from the candidate row before falling back to the existing visibility check.
drop policy if exists "Post access invariant" on public.posts;
create policy "Post access invariant"
on public.posts
as restrictive
for select
to anon, authenticated
using (
  ((select auth.uid()) is not null and user_id = (select auth.uid()))
  or public.can_read_social_post(id)
);

comment on policy "Post access invariant" on public.posts is
  'Authors can read their candidate row during INSERT RETURNING; every other read uses the existing social visibility invariant.';

notify pgrst, 'reload schema';

commit;

-- Rollback plan (only if this migration itself causes a regression): recreate
-- the policy with USING (public.can_read_social_post(id)). That restores the
-- previous behavior, including its known INSERT ... RETURNING failure.
