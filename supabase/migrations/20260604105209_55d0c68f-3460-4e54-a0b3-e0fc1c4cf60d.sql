DELETE FROM public.invalid_e2ee_devices
WHERE device_id = '84aaa52143235807214bf3aa161dd03a';

DELETE FROM public.user_devices
WHERE user_id = 'ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'
  AND device_id = '84aaa52143235807214bf3aa161dd03a'
  AND is_active = false;