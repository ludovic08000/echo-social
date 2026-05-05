CREATE OR REPLACE FUNCTION public.notify_new_device()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  device_count int;
  label text;
BEGIN
  BEGIN
    SELECT COUNT(*) INTO device_count
    FROM public.user_devices
    WHERE user_id = NEW.user_id
      AND is_active = true;

    IF device_count <= 1 THEN
      RETURN NEW;
    END IF;

    label := COALESCE(NEW.device_name, NEW.platform, 'Appareil inconnu');

    INSERT INTO public.notifications (user_id, type, actor_id, metadata, read_at)
    VALUES (
      NEW.user_id,
      'new_device'::public.notification_type,
      NEW.user_id,
      jsonb_build_object(
        'device_id',   NEW.device_id,
        'device_name', label,
        'platform',    NEW.platform,
        'user_agent',  NEW.user_agent
      ),
      NULL
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_new_device failed but ignored: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_new_device ON public.user_devices;
CREATE TRIGGER trg_notify_new_device
  AFTER INSERT ON public.user_devices
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_new_device();