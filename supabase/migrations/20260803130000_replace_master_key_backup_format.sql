-- Correction : Aegis repart avec un seul format de coffre implicite.
-- Les données de préproduction sont volontairement supprimées afin qu'aucun
-- ancien AAD ne puisse être interprété par le nouveau moteur.
BEGIN;

DELETE FROM public.user_backups;

ALTER TABLE public.user_backups
  DROP CONSTRAINT IF EXISTS user_backups_single_master_key_schema;

ALTER TABLE public.user_backups
  DROP COLUMN IF EXISTS version;

COMMIT;
