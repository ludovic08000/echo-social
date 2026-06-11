-- 1) Purge anciens messages chiffrés non compatibles avec le format ratchet strict
DELETE FROM public.messages
WHERE body IS NOT NULL
  AND body LIKE '{%'
  AND (
    body LIKE '%"ct"%' OR body LIKE '%"hdr"%' OR body LIKE '%"kem"%' OR body LIKE '%"encryptionMode"%'
  )
  AND body NOT LIKE '%"encryptionMode":"ratchet"%';

-- 2) Drop legacy one-time prekey RPC + table
DROP FUNCTION IF EXISTS public.consume_prekey(uuid);
DROP TABLE IF EXISTS public.user_prekeys CASCADE;