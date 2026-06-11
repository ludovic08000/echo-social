/**
 * useSecureBackup — Recovery Key backup using shared Master Key architecture (v5)
 * 
 * Now delegates to accountKeyBackup's Master Key system:
 * - createBackup: wraps the Master Key with a new recovery key
 * - restoreBackup: unwraps the Master Key with the recovery key, restores E2EE state
 * - Both password-wrapped and recovery-wrapped backups share the SAME Master Key
 */

import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { generateRecoveryKey, normalizeRecoveryKey, isValidRecoveryKey } from '@/lib/crypto/recoveryKey';
import { createRecoveryKeyBackup, restoreWithRecoveryKey } from '@/lib/crypto/accountKeyBackup';

export { generateRecoveryKey, normalizeRecoveryKey, isValidRecoveryKey };

export function useSecureBackup() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createBackup = useCallback(async (): Promise<string | null> => {
    if (!user) { setError('Non authentifié'); return null; }
    setIsLoading(true);
    setError(null);
    try {
      const recoveryKey = await createRecoveryKeyBackup(user.id);
      if (!recoveryKey) throw new Error('Impossible de créer la sauvegarde');
      console.log('[SecureBackup] Recovery key backup created via Master Key');
      return recoveryKey;
    } catch (err: any) {
      console.error('[SecureBackup] Backup failed:', err);
      setError(err.message || 'Échec de la sauvegarde');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const restoreBackup = useCallback(async (recoveryKey: string): Promise<boolean> => {
    if (!user) { setError('Non authentifié'); return false; }
    if (!isValidRecoveryKey(recoveryKey)) { setError('Clé de récupération invalide'); return false; }
    setIsLoading(true);
    setError(null);
    try {
      const normalized = normalizeRecoveryKey(recoveryKey);
      const ok = await restoreWithRecoveryKey(normalized, user.id);
      if (!ok) {
        setError('Impossible de déchiffrer la sauvegarde — clé incorrecte ou sauvegarde absente');
        return false;
      }
      console.log('[SecureBackup] ✅ Restored via recovery key');
      return true;
    } catch (err: any) {
      console.error('[SecureBackup] Restore failed:', err);
      setError(err.message || 'Échec de la restauration');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const hasBackup = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    try {
      const { data } = await supabase
        .from('user_backups' as any)
        .select('id')
        .eq('user_id', user.id)
        .eq('backup_type', 'recovery')
        .maybeSingle();
      return !!data;
    } catch {
      return false;
    }
  }, [user]);

  return {
    createBackup,
    restoreBackup,
    hasBackup,
    isLoading,
    error,
  };
}
