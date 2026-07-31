import { useCallback, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  createOrRotateAegisRecoveryVault,
  hasAegisRecoveryVault,
  restoreAegisRecoveryVault,
} from '@/lib/crypto/aegisRecoveryVault';
import {
  generateAegisRecoveryKey,
  isValidAegisRecoveryKey,
  normalizeAegisRecoveryKey,
} from '@/lib/crypto/aegisRecoveryProtocol';

export {
  generateAegisRecoveryKey as generateRecoveryKey,
  isValidAegisRecoveryKey as isValidRecoveryKey,
  normalizeAegisRecoveryKey as normalizeRecoveryKey,
};

export function useSecureBackup() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createBackup = useCallback(async (): Promise<string | null> => {
    if (!user) {
      setError('Non authentifié');
      return null;
    }
    setIsLoading(true);
    setError(null);
    try {
      const created = await createOrRotateAegisRecoveryVault(user.id);
      return created.recoveryKey;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Échec de la sauvegarde');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const restoreBackup = useCallback(async (recoveryKey: string): Promise<boolean> => {
    if (!user) {
      setError('Non authentifié');
      return false;
    }
    if (!isValidAegisRecoveryKey(recoveryKey)) {
      setError('Clé de récupération invalide');
      return false;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await restoreAegisRecoveryVault(user.id, recoveryKey);
      if (result.status === 'restored' || result.status === 'already_present') return true;
      if (result.status === 'conflict') {
        setError('Conflit d’identité : aucune clé locale n’a été écrasée');
      } else if (result.status === 'not_found') {
        setError('Aucun coffre de récupération trouvé');
      } else {
        setError('Clé incorrecte ou coffre illisible');
      }
      return false;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Échec de la restauration');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const hasBackup = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    try {
      return await hasAegisRecoveryVault(user.id);
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
