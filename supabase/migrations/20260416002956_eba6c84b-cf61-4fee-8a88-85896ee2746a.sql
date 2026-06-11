-- Add backup_type column to distinguish account vs recovery key backups
ALTER TABLE public.user_backups 
ADD COLUMN IF NOT EXISTS backup_type text NOT NULL DEFAULT 'account';

-- Drop old unique constraint on user_id alone (if exists)
DO $$ BEGIN
  -- Try to drop the unique constraint/index on user_id
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_backups_user_id_key' AND conrelid = 'public.user_backups'::regclass) THEN
    ALTER TABLE public.user_backups DROP CONSTRAINT user_backups_user_id_key;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Drop unique index if it exists instead of constraint
DROP INDEX IF EXISTS public.user_backups_user_id_key;
DROP INDEX IF EXISTS public.user_backups_user_id_idx;

-- Create new unique index on (user_id, backup_type)
CREATE UNIQUE INDEX IF NOT EXISTS user_backups_user_id_backup_type_key 
ON public.user_backups (user_id, backup_type);

-- Update existing rows to 'account' type
UPDATE public.user_backups SET backup_type = 'account' WHERE backup_type IS NULL;