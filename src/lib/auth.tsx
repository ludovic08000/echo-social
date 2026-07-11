import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { generateFingerprint } from '@/hooks/useTrustAndSafety';
import { startSessionGuard, stopSessionGuard } from '@/lib/sessionGuard';
import { detectAndStoreRecoveryFromHash, isRecoveryPending, setRecoveryFlag } from '@/lib/authRecovery';
import { getSafeRedirectUrl } from '@/lib/urlUtils';
import { hasLocalKeys, initAccountKeySync, restoreKeysFromKeychainSnapshot, clearAccountKeySession } from '@/lib/crypto/accountKeyBackup';
import {
  clearArchiveMasterKeySession,
  initializeArchiveMasterKeyAfterBackupCreation,
  initializeArchiveMasterKeyFromPassword,
} from '@/lib/crypto/archiveMasterKey';

/** Check URL hash for recovery tokens BEFORE any session is exposed */
function detectRecoveryFromHash(): boolean {
  return detectAndStoreRecoveryFromHash();
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
    const hasKeys = await hasLocalKeys();
    console.log(`[AUTH][E2EE] ${reason} user=${userId} hasLocalKeys=${hasKeys}`);
    if (!hasKeys) {
      const keychainStatus = await restoreKeysFromKeychainSnapshot(userId);
      if (keychainStatus === 'restored') {
        try {
          sessionStorage.setItem(
            `forsure:e2ee-resync-pending:${userId}`,
            JSON.stringify({ at: Date.now(), detail: { status: 'restored_from_keychain_auth', reason } }),
          );
        } catch {}
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const isResetRoute = typeof window !== 'undefined' && window.location.pathname === '/reset-password';

    const applySessionState = (nextSession: Session | null) => {
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setLoading(false);
    };

    const clearSessionState = () => {
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

        const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
        if (!refreshError && refreshed.session) {
          applySessionState(refreshed.session);
          if (refreshed.session.user) void inspectCryptoReadiness(refreshed.session.user.id, 'session_restored');
          return;
        }

        const { data: current } = await supabase.auth.getSession();
        applySessionState(current.session);
        if (current.session?.user) void inspectCryptoReadiness(current.session.user.id, 'session_restored');
      } catch {
        const { data: current } = await supabase.auth.getSession();
        applySessionState(current.session);
      }
    };

    void initAuth();

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, name: string, dateOfBirth?: string) => {
    try {
      const { inspectThreat } = await import('@/hooks/useThreatShield');
      const t = await inspectThreat({ endpoint: 'auth.signup', payload: `${email}|${name}` });
      if (t.blocked) return { error: { message: 'Requête bloquée par le bouclier de sécurité.' } as any };
    } catch {}
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: getSafeRedirectUrl('/auth/confirm'),
        data: { name, date_of_birth: dateOfBirth },
      },
    });
    return { error };
  };

  const signIn = async (email: string, password: string) => {
    try {
      const { inspectThreat } = await import('@/hooks/useThreatShield');
      const t = await inspectThreat({ endpoint: 'auth.signin', payload: email });
      if (t.blocked) return { error: { message: 'Requête bloquée par le bouclier de sécurité.' } as any };
    } catch {}

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (!error && data.user) {
      const userId = data.user.id;
      try {
        const localKeysPresent = await hasLocalKeys();

        // Establish the already-existing account Master Key first. This key is
        // shared by iOS and Windows only for archive/history recovery; each
        // physical device still keeps its own Sesame DeviceID and ratchets.
        const archiveStatus = await initializeArchiveMasterKeyFromPassword(password, userId);
        console.log(`[AUTH][E2EE] archive master status=${archiveStatus}`);

        if (localKeysPresent && archiveStatus === 'restored') {
          // Critical: do not call the legacy initializer here. Its old
          // local-keys branch generates a random Master Key and can overwrite
          // the existing backup, splitting iOS and Windows archive access.
          console.log('[AUTH][E2EE] local device keys kept; convergent archive key reused');
        } else if (localKeysPresent && archiveStatus === 'blocked') {
          // A backup exists but could not be unwrapped. Preserve it intact and
          // keep device messaging available rather than replacing its key.
          console.warn('[AUTH][E2EE] existing archive key could not be unlocked; backup preserved');
          try {
            window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
              detail: { userId, reason: 'archive_master_unlock_failed' },
            }));
          } catch {}
        } else {
          const status = await initAccountKeySync(password, userId);
          console.log(`[AUTH][E2EE] initAccountKeySync status=${status}`);

          // First account/device: the legacy initializer has just created the
          // encrypted account backup. Read that same key back into the
          // convergent archive manager instead of creating a second key.
          if (archiveStatus === 'no_backup') {
            const postCreateStatus = await initializeArchiveMasterKeyAfterBackupCreation(password, userId);
            console.log(`[AUTH][E2EE] archive master after backup=${postCreateStatus}`);
          }
        }
      } catch (syncError) {
        console.warn('[AUTH][E2EE] key initialization failed:', syncError);
      }

      void inspectCryptoReadiness(userId, 'signed_in');
    }

    return { error };
  };

  const signOut = async () => {
    try { stopSessionGuard(); } catch {}
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
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key && (key.startsWith('sb-') || key.startsWith('supabase.auth.'))) keys.push(key);
        }
        keys.forEach((key) => storage.removeItem(key));
      };
      purge(localStorage);
      purge(sessionStorage);
    } catch {}
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
