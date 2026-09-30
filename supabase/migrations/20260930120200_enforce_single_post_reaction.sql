-- A post reaction is mutable state, not an append-only event: one user owns
-- exactly one reaction row per post and may only change its reaction_type.

BEGIN;

LOCK TABLE public.likes IN SHARE ROW EXCLUSIVE MODE;

DO $integrity$
DECLARE
  duplicate_groups bigint;
BEGIN
  SELECT count(*)
  INTO duplicate_groups
  FROM (
    SELECT 1
    FROM public.likes
    GROUP BY user_id, post_id
    HAVING count(*) > 1
  ) AS duplicates;

  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format(
        'LIKES_DUPLICATE_USER_POST: %s duplicate group(s) must be reviewed before enforcing uniqueness',
        duplicate_groups
      );
  END IF;
END
$integrity$;

-- An older migration added a second copy of the original unique constraint.
-- Keep one canonical constraint so ON CONFLICT (user_id, post_id) remains
-- atomic without paying for two equivalent indexes on every write.
ALTER TABLE public.likes
  DROP CONSTRAINT IF EXISTS likes_user_post_unique;

DO $uniqueness$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_entry
    WHERE constraint_entry.conrelid = 'public.likes'::regclass
      AND constraint_entry.contype = 'u'
      AND pg_get_constraintdef(constraint_entry.oid) = 'UNIQUE (user_id, post_id)'
  ) THEN
    ALTER TABLE public.likes
      ADD CONSTRAINT likes_one_reaction_per_user_post
      UNIQUE (user_id, post_id);
  END IF;
END
$uniqueness$;

-- Supabase upsert needs an UPDATE policy when the unique row already exists.
-- The WITH CHECK clause prevents a user from assigning the row to somebody
-- else; the trigger below also makes the reaction's identity immutable.
DROP POLICY IF EXISTS "Users can update their own reactions" ON public.likes;
CREATE POLICY "Users can update their own reactions"
ON public.likes
FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE OR REPLACE FUNCTION public.guard_post_reaction_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.post_id IS DISTINCT FROM OLD.post_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'POST_REACTION_IDENTITY_IMMUTABLE';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_post_reaction_identity() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_post_reaction_identity ON public.likes;
CREATE TRIGGER guard_post_reaction_identity
BEFORE UPDATE ON public.likes
FOR EACH ROW
EXECUTE FUNCTION public.guard_post_reaction_identity();

COMMIT;
