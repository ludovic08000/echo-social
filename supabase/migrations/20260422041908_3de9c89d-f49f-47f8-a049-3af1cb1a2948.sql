ALTER TABLE public.privacy_settings
ADD COLUMN IF NOT EXISTS ai_personalization_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.privacy_settings.ai_personalization_enabled IS
'When false, the user opts out of having post body previews sent to the AI feed personalization service. Aggregated signals (likes, dwell, hashtags) still flow.';