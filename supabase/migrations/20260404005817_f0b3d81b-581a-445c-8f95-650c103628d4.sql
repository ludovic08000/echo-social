CREATE OR REPLACE FUNCTION public.match_contacts_by_phone(p_phone_numbers text[])
 RETURNS TABLE(user_id uuid, name text, avatar_url text, is_friend boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Rate limit: max 500 numbers per batch
  IF array_length(p_phone_numbers, 1) > 500 THEN
    RAISE EXCEPTION 'Too many phone numbers (max 500)';
  END IF;

  RETURN QUERY
  SELECT 
    p.user_id,
    p.name,
    p.avatar_url,
    EXISTS (
      SELECT 1 FROM friendships f
      WHERE f.status = 'accepted'
        AND (
          (f.requester_id = v_user_id AND f.addressee_id = p.user_id)
          OR (f.requester_id = p.user_id AND f.addressee_id = v_user_id)
        )
    ) as is_friend
  FROM profiles p
  WHERE p.phone_number = ANY(p_phone_numbers)
    AND p.user_id != v_user_id;
END;
$function$;