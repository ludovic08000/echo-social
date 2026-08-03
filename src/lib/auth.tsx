import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { generateFingerprint } from '@/hooks/useTrustAndSafety';
import { startSessionGuard, stopSessionGuard } from '@/lib/sessionGuard';
import { clearRecoveryFlag, detectAndStoreRecoveryFromHash, isRecoveryPending, setRecoveryFlag } from '@/lib/authRecovery';
import { getSafeRedirectUrl } from '@/lib/urlUtils';
import { hasLocalKeys, initAccountKeySync, restoreKeysFromKeychainSnapshot, clearAccountKeySession } from '@/lib/crypto/accountKeyBackup';
import {
  clearArchiveMasterKeySession,
  initializeArchiveMasterKeyAfterBackupCreation,
  initializeArchiveMasterKeyFromPassword,
} from '@/lib/crypto/archiveMasterKey';
import {
  ensureBackupIndexedFromR2,
  scheduleBackupMirrorToR2,
} from '@/lib/crypto/r2BackupVault';
import { primeAuthUserId } from '@/lib/crypto/peerKeyCache';
import { getOrCreateIdentityKeys } from '@/lib/crypto/keyManagerSafe';

/** Check URL hash for recovery tokens BEFORE any session is exposed */
function detectRecoveryFromHash(): boolean {
  return detectAndStoreRecoveryFromHash();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function inspectAuthThreat(endpoint: 'auth.signup' | 'auth.signin', payload: string): Promise<Error | null> {
  try {
    const result = await withTimeout(
      import('@/hooks/useThreatShield').then(({ inspectThreat }) => inspectThreat({ endpoint, payload })),
      3_500,
    );
    if (result?.blocked) return new Error('Requête bloquée par le bouclier de sécurité.');
  } catch {
    // Authentication remains available if the optional shield is unavailable.
  }
  return null;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signUp: (email: string, password: string, name: string, dateOfBirth?: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const initialRecovery = detectRecoveryFromHash() || isRecoveryPending();

async function inspectCryptoReadiness(userId: string | undefined, reason: 'session_restored' | 'signed_in') {
  if (!userId) return;
  try {
    const hasKeys = await hasLocalKeys(userId);
    console.log(`[AUTH][E2EE] ${reason} user=${userId} hasLocalKeys=${hasKeys}`);
    if (!hasKeys) {
      const keychainStatus = await restoreKeysFromKeychainSnapshot(userId);
      if (keychainStatus === 'restored') {
        try {
          sessionStorage.setItem(
            `forsure:e2ee-resync-pending:${userId}`,
            JSON.stringify({ at: Date.now(), detail: { status: 'restored_from_keychain_auth', reason } }),
          );
        } catch { /* storage can be unavailable in private browsing */ }
        window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
          detail: { status: 'restored_from_keychain_auth', reason },
        }));
        return;
      }
    }

    if (!hasKeys && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
        detail: { userId, reason },
      }));
    }
  } catch (error) {
    console.warn('[AUTH][E2EE] readiness check failed:', error);
  }
}

async function runPostSignInSetup(password: string, userId: string): Promise<void> {
  // These are independent recovery domains. Each block is isolated so a
  // network/CORS failure in R2 or an incompatible archive password can never
  // prevent restoration of the account Master Key used by PIN backup.
  let localKeysPresent = false;
  try {
    localKeysPresent = await hasLocalKeys(userId);
  } catch (error) {
    console.warn('[AUTH][E2EE] local-key inspection failed:', error);
  }

  try {
    const r2IndexStatus = await ensureBackupIndexedFromR2(userId);
    console.log(`[AUTH][E2EE] R2 backup index status=${r2IndexStatus}`);
  } catch (error) {
    console.warn('[AUTH][E2EE] R2 backup index unavailable; continuing with account backup:', error);
  }

  let accountStatus = 'unavailable';
  try {
    accountStatus = await initAccountKeySync(password, userId);
    console.log(`[AUTH][E2EE] initAccountKeySync status=${accountStatus}`);

    if (accountStatus === 'no_backup') {
      // Correction : apres la remise a zero de preproduction, le mot de passe
      // authentifie cree une seule identite avant la Master Key et son coffre.
      await getOrCreateIdentityKeys(userId);
      accountStatus = await initAccountKeySync(password, userId);
      console.log(`[AUTH][E2EE] initAccountKeySync after identity reset status=${accountStatus}`);
    }
  } catch (error) {
    console.warn('[AUTH][E2EE] account Master Key initialization failed:', error);
  }

  if (accountStatus === 'restored') {
    try {
      window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
        detail: { status: 'restored_from_password_sign_in' },
      }));
    } catch { /* browser event delivery is best-effort */ }
  }

  let archiveStatus = 'unavailable';
  try {
    archiveStatus = await initializeArchiveMasterKeyFromPassword(password, userId);
    console.log(`[AUTH][E2EE] archive master status=${archiveStatus}`);
  } catch (error) {
    console.warn('[AUTH][E2EE] archive Master Key initialization failed:', error);
  }

  if (localKeysPresent && archiveStatus === 'restored') {
    console.log('[AUTH][E2EE] local device keys kept; convergent archive key reused');
  }

  if (archiveStatus === 'blocked') {
    console.warn('[AUTH][E2EE] existing archive key could not be unlocked; backup preserved');
    try {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
        detail: { userId, reason: 'archive_master_unlock_failed' },
      }));
    } catch { /* browser event delivery is best-effort */ }
  }

  if (archiveStatus === 'no_backup') {
    try {
      const postCreateStatus = await initializeArchiveMasterKeyAfterBackupCreation(password, userId);
      console.log(`[AUTH][E2EE] archive master after backup=${postCreateStatus}`);
    } catch (error) {
      console.warn('[AUTH][E2EE] archive post-backup initialization failed:', error);
    }
  }

  scheduleBackupMirrorToR2(userId);
  void inspectCryptoReadiness(userId, 'signed_in');

  try {
    window.dispatchEvent(new CustomEvent('forsure:authenticated-device-enroll', {
      detail: { userId, source: 'password-sign-in' },
    }));
  } catch { /* browser event delivery is best-effort */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const isResetRoute = typeof window !== 'undefined' && window.location.pathname === '/reset-password';

    const applySessionState = (nextSession: Session | null) => {
      primeAuthUserId(nextSession?.user?.id ?? null);
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setLoading(false);
    };

    const clearSessionState = () => {
      primeAuthUserId(null);
      stopSessionGuard();
      clearArchiveMasterKeySession();
      clearAccountKeySession();
      setSession(null);
      setUser(null);
      setLoading(false);
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          setRecoveryFlag();
          clearSessionState();
          return;
        }

        if (event === 'SIGNED_OUT') {
          clearSessionState();
          return;
        }

        const onResetRoute = typeof window !== 'undefined' && window.location.pathname === '/reset-password';
        if (onResetRoute || detectRecoveryFromHash() || isRecoveryPending()) {
          clearSessionState();
          return;
        }

        applySessionState(session);

        if (session?.user) {
          void inspectCryptoReadiness(session.user.id, event === 'SIGNED_IN' ? 'signed_in' : 'session_restored');
        }

        if (event === 'SIGNED_IN' && session?.user) {
          if (isRecoveryPending()) return;

          startSessionGuard();

          setTimeout(() => {
            const fp = generateFingerprint();
            supabase.functions.invoke('anti-abuse', {
              body: {
                action: 'register_fingerprint',
                fingerprintHash: fp,
                screenResolution: `${screen.width}x${screen.height}`,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                language: navigator.language,
              },
            }).catch(() => {});

            supabase.functions.invoke('trust-score', {
              body: { action: 'compute' },
            }).catch(() => {});
          }, 2000);
        }
      }
    );

    const initAuth = async () => {
      try {
        const shouldBlockSession = isResetRoute || initialRecovery || detectRecoveryFromHash() || isRecoveryPending();
        if (shouldBlockSession) {
          clearSessionState();
          return;
        }

        // Supabase already owns token auto-refresh. Reading the persisted
        // session first avoids competing refresh locks across Safari/PWA tabs.
        const { data: current, error: currentError } = await supabase.auth.getSession();
        if (!currentError && current.session) {
          applySessionState(current.session);
          if (current.session.user) void inspectCryptoReadiness(current.session.user.id, 'session_restored');
          return;
        }

        // Refresh only when no usable persisted session exists.
        const { data: refreshed } = await supabase.auth.refreshSession();
        applySessionState(refreshed.session);
        if (refreshed.session?.user) void inspectCryptoReadiness(refreshed.session.user.id, 'session_restored');
      } catch {
        // An auth-lock AbortError is transient. onAuthStateChange will deliver
        // the restored session without starting another competing operation.
        setLoading(false);
      }
    };

    void initAuth();
    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, name: string, dateOfBirth?: string) => {
    const normalizedEmail = email.trim();
    const threatError = await inspectAuthThreat('auth.signup', `${normalizedEmail}|${name}`);
    if (threatError) return { error: threatError };

    const { error } = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        emailRedirectTo: getSafeRedirectUrl('/auth/confirm'),
        data: { name, date_of_birth: dateOfBirth },
      },
    });
    return { error };
  };

  const signIn = async (email: string, password: string) => {
    // A previous, abandoned password-reset flow must not invalidate a normal
    // explicit password login on the same browser tab.
    clearRecoveryFlag();

    const normalizedEmail = email.trim();
    const threatError = await inspectAuthThreat('auth.signin', normalizedEmail);
    if (threatError) return { error: threatError };

    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (!error && data.user) {
      // Authentication has succeeded. Do not await R2, IndexedDB or E2EE key
      // restoration here: those services continue in the background.
      void runPostSignInSetup(password, data.user.id);
    }

    return { error };
  };

  const signOut = async () => {
    try { stopSessionGuard(); } catch { /* guard may already be stopped */ }
    clearArchiveMasterKeySession();
    clearAccountKeySession();
    setSession(null);
    setUser(null);

    try {
      const { error } = await supabase.auth.signOut({ scope: 'global' });
      if (error) {
        console.warn('[AUTH] global signOut failed, falling back to local', error);
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      }
    } catch (err) {
      console.warn('[AUTH] signOut threw, forcing local cleanup', err);
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    }

    try {
      const purge = (storage: Storage) => {
        const keys: string[] = [];
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index);
          if (key && (key.startsWith('sb-') || key.startsWith('supabase.auth.'))) keys.push(key);
        }
        keys.forEach((key) => storage.removeItem(key));
      };
      purge(localStorage);
      purge(sessionStorage);
    } catch { /* storage can be unavailable in private browsing */ }
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
