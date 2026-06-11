-- Backfill: assign a "loose" platform-family fingerprint to existing iOS
-- devices so they can be matched on next cold start even before the client
-- has a chance to send the new strict fingerprint.
UPDATE public.user_devices
SET device_fingerprint = encode(digest(
  'platform:' || CASE
    WHEN user_agent ILIKE '%iPad%' THEN 'iPad'
    WHEN user_agent ILIKE '%iPhone%' THEN 'iPhone'
    WHEN user_agent ILIKE '%iPod%' THEN 'iPod'
    ELSE 'Unknown'
  END,
  'sha256'
), 'hex')
WHERE platform = 'ios'
  AND is_active = true
  AND revoked_at IS NULL
  AND (device_fingerprint IS NULL OR device_fingerprint = '');