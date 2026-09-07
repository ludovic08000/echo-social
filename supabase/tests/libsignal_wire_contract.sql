BEGIN;
DO $test$
DECLARE sample text;
BEGIN
  FOREACH sample IN ARRAY ARRAY['aegis.libsignal.2.AQID','aegis.libsignal.3.AQID','aegis.libsignal.3.AQ==','aegis.libsignal.3.AQI='] LOOP
    IF public.is_supported_aegis_device_copy(sample) IS DISTINCT FROM true THEN RAISE EXCEPTION 'VALID_REJECTED:%',sample; END IF;
  END LOOP;
  FOREACH sample IN ARRAY ARRAY['aegis1.ratchet.AQID','aegis1.init.v1.AQID','aegis.libsignal.7.AQID','aegis.libsignal.8.AQID','aegis.libsignal.03.AQID','aegis.libsignal..AQID','aegis.libsignal.3.','aegis.libsignal.3.AQ','aegis.libsignal.3.AR==',E'aegis.libsignal.3.AQID\n','aegis.libsignal.3.AQID.extra'] LOOP
    IF public.is_supported_aegis_device_copy(sample) IS DISTINCT FROM false THEN RAISE EXCEPTION 'INVALID_ACCEPTED:%',sample; END IF;
  END LOOP;
  IF has_function_privilege('anon','public.aegis_send_message(uuid,uuid,text,text,jsonb,jsonb,text,text)','execute') THEN RAISE EXCEPTION 'ANON_SEND_ALLOWED'; END IF;
  IF NOT has_function_privilege('authenticated','public.aegis_send_message(uuid,uuid,text,text,jsonb,jsonb,text,text)','execute') THEN RAISE EXCEPTION 'AUTH_SEND_DENIED'; END IF;
END $test$;
CREATE TEMP TABLE wire_contract_test(body text CHECK(public.is_supported_aegis_device_copy(body))) ON COMMIT DROP;
INSERT INTO wire_contract_test VALUES ('aegis.libsignal.3.AQID'),('aegis.libsignal.2.AQID');
DO $test$
BEGIN
  BEGIN
    INSERT INTO wire_contract_test VALUES ('aegis1.ratchet.AQID');
    RAISE EXCEPTION 'CHECK_DID_NOT_REJECT';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $test$;
ROLLBACK;
