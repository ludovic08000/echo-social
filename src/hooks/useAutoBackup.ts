/**
 * useAutoBackup — Legacy compatibility wrapper
 * 
 * Now delegates to the Master Key auto-sync system (useAccountKeySync).
 * Kept for backward compatibility with components that reference it.
 */

import { useCallback, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { syncBackupToServer, isAutoBackupActive } from '@/lib/crypto/accountKeyBackup';

export function useAutoBackup() {
  const { user } = useAuth();
  const [hasKey] = useState(() => isAutoBackupActive());

  const setRecoveryKey = useCallback((_key: string) => {
    // No-op: Master Key system handles this automatically
  }, []);

  const clearRecoveryKey = useCallback(() => {
    // No-op: cleared via clearAccountKeySession on logout
  }, []);

  const triggerBackup = useCallback(() => {
    if (!user) return;
    syncBackupToServer().catch(() => {});
  }, [user]);

  return { setRecoveryKey, clearRecoveryKey, triggerBackup, hasKey };
}
