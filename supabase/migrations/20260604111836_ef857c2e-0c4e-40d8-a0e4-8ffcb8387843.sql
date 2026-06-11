-- Nettoyage: deux SPK actifs sur l'appareil iOS 84aaa5... causent une ambiguïté.
-- On garde uniquement la plus récente (spk_id=9, 2026-06-04 10:53) et on supprime
-- la ligne fantôme spk_id=4 (réutilisation d'identifiant le 2026-05-25).
UPDATE public.device_signed_prekeys
   SET is_active = false
 WHERE device_id = '84aaa52143235807214bf3aa161dd03a'
   AND spk_id = 4
   AND is_active = true;

DELETE FROM public.device_signed_prekeys
 WHERE device_id = '84aaa52143235807214bf3aa161dd03a'
   AND spk_id = 4
   AND created_at < '2026-06-04'::timestamptz;