
CREATE OR REPLACE FUNCTION public.check_peer_knows_my_fingerprint(p_peer_user_id uuid)
RETURNS TABLE(fingerprint text, acknowledged boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT ukf.fingerprint, ukf.acknowledged
  FROM public.user_known_fingerprints ukf
  WHERE ukf.user_id = p_peer_user_id
    AND ukf.peer_user_id = auth.uid()
  LIMIT 1;
$$;
