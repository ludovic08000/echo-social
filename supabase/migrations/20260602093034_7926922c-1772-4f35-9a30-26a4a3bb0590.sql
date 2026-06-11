
-- Quarantine table
CREATE TABLE IF NOT EXISTS public.invalid_e2ee_devices (
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  reason text NOT NULL DEFAULT 'invalid_e2ee_device',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);
GRANT SELECT ON public.invalid_e2ee_devices TO authenticated;
GRANT ALL ON public.invalid_e2ee_devices TO service_role;
ALTER TABLE public.invalid_e2ee_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invalid_e2ee_devices_read_own" ON public.invalid_e2ee_devices;
CREATE POLICY "invalid_e2ee_devices_read_own" ON public.invalid_e2ee_devices
FOR SELECT TO authenticated USING (user_id = auth.uid());

INSERT INTO public.invalid_e2ee_devices (user_id, device_id, reason) VALUES
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '84aaa52143235807214bf3aa161dd03a', 'revoked_device_reactivation_blocked'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '6508eb47a200893f49720fe84b9290b3', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '9da8c742a4fe81d1d9ce6c0ffb4e055b', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '75e575fcbfaa8066bcbc9105fc5f4ac8', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, 'c6601674b0f700f28c9f2956774eca97', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '52adb13ff236ae5c833c9d9049c0df71', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, 'b166de502d729356dcbd6c0b5b1a39b0', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '49cfdeab59355de3051925b4f09fba75', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '92585130870cedf210af1019379dbc61', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '450c0cd9af35813c8a99ec5bc0f39ab8', 'invalid_device_spk_signature')
ON CONFLICT (user_id, device_id) DO UPDATE SET reason = EXCLUDED.reason;

UPDATE public.user_devices ud SET is_active = false
WHERE EXISTS (SELECT 1 FROM public.invalid_e2ee_devices bad WHERE bad.user_id=ud.user_id AND bad.device_id=ud.device_id);
UPDATE public.device_signed_prekeys dsp SET is_active=false, is_last_resort=false
WHERE EXISTS (SELECT 1 FROM public.invalid_e2ee_devices bad WHERE bad.user_id=dsp.user_id AND bad.device_id=dsp.device_id);
DELETE FROM public.device_one_time_prekeys opk
WHERE EXISTS (SELECT 1 FROM public.invalid_e2ee_devices bad WHERE bad.user_id=opk.user_id AND bad.device_id=opk.device_id);

-- Signed device list
CREATE TABLE IF NOT EXISTS public.signed_device_lists (
  user_id uuid PRIMARY KEY,
  device_ids text[] NOT NULL DEFAULT '{}',
  list_version bigint NOT NULL DEFAULT 1,
  signer_device_id text,
  signature text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.signed_device_lists TO authenticated;
GRANT ALL ON public.signed_device_lists TO service_role;
ALTER TABLE public.signed_device_lists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "signed_device_lists_read_authenticated" ON public.signed_device_lists;
CREATE POLICY "signed_device_lists_read_authenticated" ON public.signed_device_lists
FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "signed_device_lists_write_own" ON public.signed_device_lists;
CREATE POLICY "signed_device_lists_write_own" ON public.signed_device_lists
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Per-device retry queue
CREATE TABLE IF NOT EXISTS public.device_copy_retry_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL,
  sender_user_id uuid NOT NULL,
  requester_user_id uuid NOT NULL,
  requester_device_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, sender_user_id, requester_user_id, requester_device_id)
);
GRANT SELECT, INSERT, UPDATE ON public.device_copy_retry_requests TO authenticated;
GRANT ALL ON public.device_copy_retry_requests TO service_role;
ALTER TABLE public.device_copy_retry_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "retry_request_insert_self" ON public.device_copy_retry_requests;
CREATE POLICY "retry_request_insert_self" ON public.device_copy_retry_requests
FOR INSERT TO authenticated WITH CHECK (requester_user_id = auth.uid());
DROP POLICY IF EXISTS "retry_request_read_sender_or_requester" ON public.device_copy_retry_requests;
CREATE POLICY "retry_request_read_sender_or_requester" ON public.device_copy_retry_requests
FOR SELECT TO authenticated USING (sender_user_id = auth.uid() OR requester_user_id = auth.uid());
DROP POLICY IF EXISTS "retry_request_update_sender" ON public.device_copy_retry_requests;
CREATE POLICY "retry_request_update_sender" ON public.device_copy_retry_requests
FOR UPDATE TO authenticated USING (sender_user_id = auth.uid()) WITH CHECK (sender_user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_device_copy_retry_sender_pending
  ON public.device_copy_retry_requests (sender_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_copy_retry_message
  ON public.device_copy_retry_requests (message_id);

-- Peer prekey repair queue
CREATE TABLE IF NOT EXISTS public.device_prekey_repair_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  owner_device_id text NOT NULL,
  reporter_user_id uuid NOT NULL,
  reason text NOT NULL DEFAULT 'invalid_device_spk_signature',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
GRANT SELECT, INSERT, UPDATE ON public.device_prekey_repair_requests TO authenticated;
GRANT ALL ON public.device_prekey_repair_requests TO service_role;
ALTER TABLE public.device_prekey_repair_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "prekey_repair_read_involved" ON public.device_prekey_repair_requests;
CREATE POLICY "prekey_repair_read_involved" ON public.device_prekey_repair_requests
FOR SELECT TO authenticated USING (owner_user_id = auth.uid() OR reporter_user_id = auth.uid());
DROP POLICY IF EXISTS "prekey_repair_insert_reporter" ON public.device_prekey_repair_requests;
CREATE POLICY "prekey_repair_insert_reporter" ON public.device_prekey_repair_requests
FOR INSERT TO authenticated WITH CHECK (reporter_user_id = auth.uid());
DROP POLICY IF EXISTS "prekey_repair_update_owner" ON public.device_prekey_repair_requests;
CREATE POLICY "prekey_repair_update_owner" ON public.device_prekey_repair_requests
FOR UPDATE TO authenticated USING (owner_user_id = auth.uid()) WITH CHECK (owner_user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_prekey_repair_owner_pending
  ON public.device_prekey_repair_requests (owner_user_id, status, created_at DESC);

-- RPCs
CREATE OR REPLACE FUNCTION public.is_user_device_revoked(p_user_id uuid, p_device_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE='42501';
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.user_devices ud
    WHERE ud.user_id=p_user_id AND ud.device_id=p_device_id AND coalesce(ud.is_active,false)=false);
END; $$;
GRANT EXECUTE ON FUNCTION public.is_user_device_revoked(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.register_user_device_safe(
  p_user_id uuid, p_device_id text,
  p_device_name text DEFAULT NULL, p_device_public_key text DEFAULT NULL,
  p_device_fingerprint text DEFAULT NULL, p_platform text DEFAULT NULL, p_user_agent text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_revoked boolean; v_quarantined boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RETURN jsonb_build_object('ok',false,'code','NOT_AUTHORIZED'); END IF;
  IF p_user_id IS NULL OR p_device_id IS NULL OR length(trim(p_device_id))<8 THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_DEVICE_PAYLOAD'); END IF;
  SELECT EXISTS (SELECT 1 FROM public.invalid_e2ee_devices
    WHERE user_id=p_user_id AND device_id=p_device_id) INTO v_quarantined;
  IF v_quarantined THEN RETURN jsonb_build_object('ok',false,'code','DEVICE_QUARANTINED'); END IF;
  SELECT public.is_user_device_revoked(p_user_id, p_device_id) INTO v_revoked;
  IF v_revoked THEN RETURN jsonb_build_object('ok',false,'code','DEVICE_REVOKED'); END IF;

  INSERT INTO public.user_devices (user_id, device_id, device_name, device_public_key,
    device_fingerprint, platform, user_agent, is_active, last_seen_at)
  VALUES (p_user_id, p_device_id, p_device_name, p_device_public_key,
    p_device_fingerprint, p_platform, p_user_agent, true, now())
  ON CONFLICT (user_id, device_id) DO UPDATE SET
    device_name=EXCLUDED.device_name, device_public_key=EXCLUDED.device_public_key,
    device_fingerprint=EXCLUDED.device_fingerprint, platform=EXCLUDED.platform,
    user_agent=EXCLUDED.user_agent, is_active=true, last_seen_at=now()
  WHERE public.user_devices.user_id=auth.uid() AND public.user_devices.is_active=true;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','DEVICE_REVOKED_OR_LOCKED'); END IF;
  RETURN jsonb_build_object('ok',true,'code','DEVICE_REGISTERED','device_id',p_device_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.register_user_device_safe(uuid,text,text,text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.resolve_device_id_by_fingerprints(
  p_fingerprints text[], p_platform text DEFAULT NULL
) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT ud.device_id FROM public.user_devices ud
  WHERE ud.user_id=auth.uid() AND ud.is_active=true
    AND ud.device_fingerprint = ANY(coalesce(p_fingerprints,'{}'))
    AND (p_platform IS NULL OR ud.platform=p_platform)
    AND NOT EXISTS (SELECT 1 FROM public.invalid_e2ee_devices bad
      WHERE bad.user_id=ud.user_id AND bad.device_id=ud.device_id)
  ORDER BY ud.last_seen_at DESC NULLS LAST LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.resolve_device_id_by_fingerprints(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_device_id_by_fingerprints(text[], text) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_active_devices_for_user(p_user_id uuid)
RETURNS TABLE (device_id text, device_public_key text, platform text, last_seen_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH sdl AS (SELECT device_ids FROM public.signed_device_lists WHERE user_id=p_user_id),
       sdl_ids AS (SELECT unnest(device_ids) AS device_id FROM sdl)
  SELECT ud.device_id, ud.device_public_key, ud.platform, ud.last_seen_at
  FROM public.user_devices ud
  WHERE ud.user_id=p_user_id AND ud.is_active=true AND ud.device_public_key IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.invalid_e2ee_devices bad
      WHERE bad.user_id=ud.user_id AND bad.device_id=ud.device_id)
    AND (
      NOT EXISTS (SELECT 1 FROM sdl)
      OR ud.device_id IN (SELECT device_id FROM sdl_ids)
    )
  ORDER BY ud.last_seen_at DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION public.list_active_devices_for_user(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_device_prekey_bundle(p_user_id uuid, p_device_id text)
RETURNS TABLE (spk_id integer, public_key text, signature text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT dsp.spk_id, dsp.public_key, dsp.signature
  FROM public.device_signed_prekeys dsp
  JOIN public.user_devices ud ON ud.user_id=dsp.user_id AND ud.device_id=dsp.device_id
  WHERE dsp.user_id=p_user_id AND dsp.device_id=p_device_id
    AND dsp.is_active=true AND ud.is_active=true
    AND NOT EXISTS (SELECT 1 FROM public.invalid_e2ee_devices bad
      WHERE bad.user_id=dsp.user_id AND bad.device_id=dsp.device_id)
  ORDER BY dsp.created_at DESC NULLS LAST, dsp.spk_id DESC LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_device_prekey_bundle(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.quarantine_own_invalid_device(
  p_device_id text, p_reason text DEFAULT 'invalid_device_spk_signature'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); END IF;
  IF p_device_id IS NULL OR length(trim(p_device_id))<8 THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_DEVICE_ID'); END IF;
  INSERT INTO public.invalid_e2ee_devices (user_id, device_id, reason)
  VALUES (v_user, p_device_id, left(coalesce(p_reason,'invalid_device_spk_signature'),200))
  ON CONFLICT (user_id, device_id) DO UPDATE SET reason=EXCLUDED.reason;
  UPDATE public.user_devices SET is_active=false WHERE user_id=v_user AND device_id=p_device_id;
  UPDATE public.device_signed_prekeys SET is_active=false, is_last_resort=false
    WHERE user_id=v_user AND device_id=p_device_id;
  RETURN jsonb_build_object('ok',true,'code','DEVICE_QUARANTINED','device_id',p_device_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.quarantine_own_invalid_device(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.quarantine_own_invalid_device_spk(
  p_device_id text, p_spk_id integer, p_reason text DEFAULT 'invalid_device_spk_signature'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_device_updated int := 0; v_spk_updated int := 0;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); END IF;
  IF p_device_id IS NULL OR length(trim(p_device_id))<8 THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_DEVICE_ID'); END IF;
  UPDATE public.device_signed_prekeys SET is_active=false, is_last_resort=false
    WHERE user_id=v_user AND device_id=p_device_id
      AND (spk_id=p_spk_id OR is_active=true OR is_last_resort=true);
  GET DIAGNOSTICS v_spk_updated = ROW_COUNT;
  UPDATE public.user_devices SET is_active=false, updated_at=now()
    WHERE user_id=v_user AND device_id=p_device_id AND is_active=true;
  GET DIAGNOSTICS v_device_updated = ROW_COUNT;
  RETURN jsonb_build_object('ok',true,'code','OWN_INVALID_DEVICE_QUARANTINED',
    'device_id',p_device_id,'spk_id',p_spk_id,
    'devices_deactivated',v_device_updated,'spks_deactivated',v_spk_updated);
END; $$;
GRANT EXECUTE ON FUNCTION public.quarantine_own_invalid_device_spk(text, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_signed_device_list(
  p_device_ids text[], p_signer_device_id text DEFAULT NULL, p_signature text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_clean text[];
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); END IF;
  SELECT coalesce(array_agg(DISTINCT d),'{}') INTO v_clean
  FROM unnest(coalesce(p_device_ids,'{}')) d
  WHERE d IS NOT NULL AND length(trim(d))>=8;
  INSERT INTO public.signed_device_lists(user_id, device_ids, list_version, signer_device_id, signature, updated_at)
  VALUES (v_user, v_clean, 1, p_signer_device_id, p_signature, now())
  ON CONFLICT (user_id) DO UPDATE SET device_ids=EXCLUDED.device_ids,
    list_version=public.signed_device_lists.list_version+1,
    signer_device_id=EXCLUDED.signer_device_id,
    signature=EXCLUDED.signature, updated_at=now();
  RETURN jsonb_build_object('ok',true,'device_count',coalesce(array_length(v_clean,1),0));
END; $$;
GRANT EXECUTE ON FUNCTION public.upsert_signed_device_list(text[], text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_device_copy_retry(
  p_message_id uuid, p_sender_user_id uuid, p_requester_device_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_requester uuid := auth.uid(); v_message_sender uuid; v_is_participant boolean;
BEGIN
  IF v_requester IS NULL THEN RETURN jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); END IF;
  SELECT m.sender_id INTO v_message_sender FROM public.messages m WHERE m.id=p_message_id;
  IF v_message_sender IS NULL OR v_message_sender <> p_sender_user_id THEN
    RETURN jsonb_build_object('ok',false,'code','MESSAGE_SENDER_MISMATCH'); END IF;
  SELECT EXISTS (SELECT 1 FROM public.messages m
    JOIN public.conversation_participants cp ON cp.conversation_id=m.conversation_id
    WHERE m.id=p_message_id AND cp.user_id=v_requester) INTO v_is_participant;
  IF NOT v_is_participant THEN
    RETURN jsonb_build_object('ok',false,'code','NOT_CONVERSATION_PARTICIPANT'); END IF;
  INSERT INTO public.device_copy_retry_requests (message_id, sender_user_id, requester_user_id,
    requester_device_id, status, attempts, updated_at)
  VALUES (p_message_id, p_sender_user_id, v_requester, p_requester_device_id, 'pending', 0, now())
  ON CONFLICT (message_id, sender_user_id, requester_user_id, requester_device_id)
  DO UPDATE SET status='pending', updated_at=now(), last_error=NULL;
  RETURN jsonb_build_object('ok',true,'code','RETRY_REQUEST_QUEUED');
END; $$;
GRANT EXECUTE ON FUNCTION public.request_device_copy_retry(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_pending_device_copy_retry_requests(p_limit integer DEFAULT 50)
RETURNS TABLE (id uuid, message_id uuid, conversation_id uuid,
  requester_user_id uuid, requester_device_id text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT r.id, r.message_id, m.conversation_id, r.requester_user_id, r.requester_device_id, r.created_at
  FROM public.device_copy_retry_requests r
  JOIN public.messages m ON m.id=r.message_id
  WHERE r.sender_user_id=auth.uid() AND r.status='pending'
  ORDER BY r.created_at ASC
  LIMIT greatest(1, least(coalesce(p_limit,50), 200));
END; $$;
GRANT EXECUTE ON FUNCTION public.get_pending_device_copy_retry_requests(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_device_copy_retry_request(
  p_request_id uuid, p_status text, p_error text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); END IF;
  IF p_status NOT IN ('processing','done','failed','pending') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_STATUS'); END IF;
  UPDATE public.device_copy_retry_requests
  SET status=p_status,
      attempts=CASE WHEN p_status IN ('processing','failed') THEN attempts+1 ELSE attempts END,
      last_error=p_error, updated_at=now()
  WHERE id=p_request_id AND sender_user_id=auth.uid();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','NOT_FOUND_OR_NOT_OWNER'); END IF;
  RETURN jsonb_build_object('ok',true,'code','UPDATED');
END; $$;
GRANT EXECUTE ON FUNCTION public.mark_device_copy_retry_request(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_active_device_public_key(p_user_id uuid, p_device_id text)
RETURNS TABLE (user_id uuid, device_id text, device_public_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT ud.user_id, ud.device_id, ud.device_public_key FROM public.user_devices ud
  WHERE ud.user_id=p_user_id AND ud.device_id=p_device_id
    AND ud.is_active=true AND ud.device_public_key IS NOT NULL LIMIT 1;
END; $$;
GRANT EXECUTE ON FUNCTION public.get_active_device_public_key(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cleanup_current_user_stale_devices(
  p_current_device_id text, p_stale_after interval DEFAULT interval '30 days'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_deactivated int := 0; v_spks_deactivated int := 0;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); END IF;
  UPDATE public.user_devices SET is_active=false, updated_at=coalesce(updated_at, now())
  WHERE user_id=v_user AND device_id<>p_current_device_id AND is_active=true
    AND coalesce(last_seen_at, created_at, now()-interval '100 years') < now() - p_stale_after;
  GET DIAGNOSTICS v_deactivated = ROW_COUNT;
  UPDATE public.device_signed_prekeys dsp SET is_active=false, is_last_resort=false
  WHERE dsp.user_id=v_user AND dsp.device_id<>p_current_device_id
    AND EXISTS (SELECT 1 FROM public.user_devices ud
      WHERE ud.user_id=dsp.user_id AND ud.device_id=dsp.device_id AND ud.is_active=false);
  GET DIAGNOSTICS v_spks_deactivated = ROW_COUNT;
  RETURN jsonb_build_object('ok',true,'code','STALE_DEVICES_CLEANED',
    'devices_deactivated',v_deactivated,'spks_deactivated',v_spks_deactivated);
END; $$;
GRANT EXECUTE ON FUNCTION public.cleanup_current_user_stale_devices(text, interval) TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_device_one_time_prekey(p_user_id uuid, p_device_id text)
RETURNS TABLE (opk_id integer, public_key text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT NULL::integer AS opk_id, NULL::text AS public_key WHERE false;
$$;
GRANT EXECUTE ON FUNCTION public.claim_device_one_time_prekey(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_device_prekey_repair(
  p_owner_user_id uuid, p_owner_device_id text, p_reason text DEFAULT 'invalid_device_spk_signature'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_reporter uuid := auth.uid();
BEGIN
  IF v_reporter IS NULL THEN RETURN jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); END IF;
  IF p_owner_user_id IS NULL OR p_owner_device_id IS NULL OR length(trim(p_owner_device_id))<8 THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_INPUT'); END IF;
  IF v_reporter = p_owner_user_id THEN
    PERFORM public.quarantine_own_invalid_device(p_owner_device_id, p_reason);
    RETURN jsonb_build_object('ok',true,'code','SELF_QUARANTINED');
  END IF;
  INSERT INTO public.device_prekey_repair_requests (owner_user_id, owner_device_id, reporter_user_id, reason)
  VALUES (p_owner_user_id, p_owner_device_id, v_reporter, left(coalesce(p_reason,'invalid_device_spk_signature'),200));
  RETURN jsonb_build_object('ok',true,'code','REPAIR_REQUEST_QUEUED');
END; $$;
GRANT EXECUTE ON FUNCTION public.request_device_prekey_repair(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.consume_device_prekey_repair_requests(p_limit integer DEFAULT 50)
RETURNS TABLE (id uuid, owner_device_id text, reporter_user_id uuid, reason text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  RETURN QUERY
  UPDATE public.device_prekey_repair_requests r
  SET status='resolved', resolved_at=now()
  WHERE r.id IN (
    SELECT id FROM public.device_prekey_repair_requests
    WHERE owner_user_id=auth.uid() AND status='pending'
    ORDER BY created_at ASC
    LIMIT greatest(1, least(coalesce(p_limit,50), 200))
  )
  RETURNING r.id, r.owner_device_id, r.reporter_user_id, r.reason, r.created_at;
END; $$;
GRANT EXECUTE ON FUNCTION public.consume_device_prekey_repair_requests(integer) TO authenticated;

DELETE FROM public.device_one_time_prekeys;
