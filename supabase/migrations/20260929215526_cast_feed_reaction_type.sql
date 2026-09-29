-- Preserve the deployed feed function byte-for-byte except for the output type
-- of `user_reaction`. The likes column is the `reaction_type` enum while the
-- public RPC contract declares this field as text.
DO $migration$
DECLARE
  v_definition text;
  v_updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.get_feed_posts_v8(uuid,integer,integer)'::regprocedure
  )
  INTO v_definition;

  IF position('l.reaction_type::text AS user_reaction' IN v_definition) > 0 THEN
    RETURN;
  END IF;

  v_updated_definition := replace(
    v_definition,
    'l.reaction_type AS user_reaction',
    'l.reaction_type::text AS user_reaction'
  );

  IF v_updated_definition = v_definition THEN
    RAISE EXCEPTION
      'Expected get_feed_posts_v8 reaction_type projection was not found';
  END IF;

  EXECUTE v_updated_definition;
END;
$migration$;
