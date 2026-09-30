import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { generateFingerprint } from '@/hooks/useTrustAndSafety';
import { startSessionGuard, stopSessionGuard } from '@/lib/sessionGuard';
import { clearRecoveryFlag, detectAndStoreRecoveryFromHash, isRecoveryPending, setRecoveryFlag } from '@/lib/authRecovery';
import { getSafeRedirectUrl } from '@/lib/urlUtils';
import {
  clearAccountKeySession,
  hasAccountMasterKeySession,
  hasLocalKeys,
  initAccountKeySync,
  restoreAccountMasterKeyFromDeviceStore,
  restoreKeysFromKeychainSnapshot,
} from '@/lib/crypto/accountKeyBackup';
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
import { resetAccountSynchronization } from '@/lib/messaging/accountSyncBarrier';
import { invalidateAegisDeviceRuntime } from '@/lib/messaging/aegisDeviceRuntime';
import { clearPinUnlockedSession } from '@/lib/device-manager/pinUnlockSignal';
import { setCurrentDeviceUserScope } from '@/lib/messaging/currentDevice';
import {
  assessCurrentLoginSession,
  isLoginSecurityServerGateOpen,
  readCurrentLoginSecuritySession,
  resendLoginSecurityEmail,
  type LoginSecuritySession,
  type LoginSecurityState,
} from '@/lib/security/loginSecurity';

function clearMessagingSession(userId?: string | null): void {
  clearPinUnlockedSession(userId);
  resetAccountSynchronization(userId ?? undefined);
  invalidateAegisDeviceRuntime(userId ?? undefined);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('forsure:logout', {
      detail: { userId: userId ?? undefined },
    }));
    window.dispatchEvent(new CustomEvent('forsure:e2ee-purge', {
      detail: { userId: userId ?? undefined, reason: 'session_cleared' },
    }));
  }
}

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
  cryptoRestoring: boolean;
  loginSecurity: LoginSecurityState;
  signUp: (email: string, password: string, name: string, dateOfBirth?: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshLoginSecurity: () => Promise<void>;
  resendLoginApprovalEmail: () => Promise<void>;
}

async function checkLoginRateLimit(email: string): Promise<Error | null> {
  try {
    const result = await withTimeout(
      supabase.functions.invoke('login-rate-limit', {
        body: { action: 'check', email },
      }),
      3_500,
    );
    const data = result?.data as { allowed?: boolean; retry_after_seconds?: number } | undefined;
    if (data?.allowed === false) {
      const wait = Math.max(1, Math.ceil((data.retry_after_seconds || 60) / 60));
      return new Error(`Trop de tentatives. Réessayez dans ${wait} minute${wait > 1 ? 's' : ''}.`);
    }
  } catch {
    // The rate-limit service is additive and must not create an auth outage.
  }
  return null;
}

async function recordLoginAttempt(email: string, success: boolean): Promise<void> {
  await supabase.functions.invoke('login-rate-limit', {
    body: { action: 'record', email, success },
  }).catch(() => undefined);
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const initialRecovery = detectRecoveryFromHash() || isRecoveryPending();

async function inspectCryptoReadiness(userId: string | undefined, reason: 'session_restored' | 'signed_in') {
  if (!userId) return;
  try {
    let hasKeys = await hasLocalKeys(userId);
    console.log(`[AUTH][E2EE] ${reason} user=${userId} hasLocalKeys=${hasKeys}`);
    if (!hasKeys) {
      const keychainStatus = await restoreKeysFromKeychainSnapshot(userId);
      if (keychainStatus === 'restored') {
        hasKeys = await hasLocalKeys(userId);
        try {
          sessionStorage.setItem(
            `forsure:e2ee-resync-pending:${userId}`,
            JSON.stringify({ at: Date.now(), detail: { status: 'restored_from_keychain_auth', reason } }),
          );
        } catch { /* storage can be unavailable in private browsing */ }
        window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
          detail: { status: 'restored_from_keychain_auth', reason },
        }));
      }
    }

    const deviceMasterStatus = await restoreAccountMasterKeyFromDeviceStore(userId);
    const masterKeyReady = hasAccountMasterKeySession(userId);
    console.log(`[AUTH][E2EE] ${reason} user=${userId} masterKey=${deviceMasterStatus}`);

    if ((!hasKeys || !masterKeyReady) && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
        detail: {
          userId,
          reason: hasKeys ? 'account_master_key_locked' : reason,
        },
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
  const [cryptoRestoring, setCryptoRestoring] = useState(false);
  const [loginSecurity, setLoginSecurity] = useState<LoginSecurityState>({
    status: 'signed_out',
    session: null,
  });
  const activeUserIdRef = useRef<string | null>(null);
  const loginSecurityRef = useRef<LoginSecurityState>({ status: 'signed_out', session: null });
  const assessmentRef = useRef<{ token: string; promise: Promise<LoginSecuritySession> } | null>(null);
  const pendingPasswordRef = useRef<{ userId: string; password: string } | null>(null);
  const postSignInSetupRef = useRef<Promise<void> | null>(null);
  const approvedServicesTokenRef = useRef<string | null>(null);

  const updateLoginSecurity = useCallback((next: LoginSecurityState) => {
    loginSecurityRef.current = next;
    setLoginSecurity(next);
  }, []);

  const startApprovedSessionServices = useCallback((approvedSession: Session) => {
    if (approvedServicesTokenRef.current === approvedSession.access_token) return;
    approvedServicesTokenRef.current = approvedSession.access_token;
    startSessionGuard();
    void inspectCryptoReadiness(approvedSession.user.id, 'session_restored');

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
  }, []);

  const ensureLoginSecurity = useCallback(async (
    authenticatedSession: Session,
  ): Promise<LoginSecuritySession> => {
    const token = authenticatedSession.access_token;
    if (assessmentRef.current?.token === token) return assessmentRef.current.promise;

    updateLoginSecurity({ status: 'checking', session: loginSecurityRef.current.session });
    setCurrentDeviceUserScope(authenticatedSession.user.id);

    const promise = (async () => {
      try {
        const assessed = await assessCurrentLoginSession(authenticatedSession.user.id);
        const status = assessed.status === 'expired' ? 'pending' : assessed.status;
        updateLoginSecurity({ status, session: assessed });
        if (status === 'approved') startApprovedSessionServices(authenticatedSession);
        return assessed;
      } catch (error) {
        // During the staged rollout the database gate is intentionally open.
        // Once enforcement is enabled this fallback succeeds only for a session
        // already approved server-side, so an outage fails closed.
        if (await isLoginSecurityServerGateOpen()) {
          const rolloutSession: LoginSecuritySession = {
            status: 'approved',
            riskLevel: 'low',
            approvedVia: 'server_gate',
          };
          updateLoginSecurity({ status: 'approved', session: rolloutSession });
          startApprovedSessionServices(authenticatedSession);
          return rolloutSession;
        }
        const errorCode = error instanceof Error ? error.message : 'LOGIN_SECURITY_REQUEST_FAILED';
        updateLoginSecurity({ status: 'error', session: null, errorCode });
        throw error;
      }
    })().finally(() => {
      if (assessmentRef.current?.promise === promise) assessmentRef.current = null;
    });

    assessmentRef.current = { token, promise };
    return promise;
  }, [startApprovedSessionServices, updateLoginSecurity]);

  const completePendingPasswordSetup = useCallback(async (userId: string): Promise<void> => {
    const pending = pendingPasswordRef.current;
    if (!pending || pending.userId !== userId) return;
    if (postSignInSetupRef.current) return postSignInSetupRef.current;

    pendingPasswordRef.current = null;
    setCryptoRestoring(true);
    const job = runPostSignInSetup(pending.password, userId)
      .finally(() => {
        if (postSignInSetupRef.current === job) postSignInSetupRef.current = null;
        setCryptoRestoring(false);
      });
    postSignInSetupRef.current = job;
    return job;
  }, []);

  useEffect(() => {
    const isResetRoute = typeof window !== 'undefined' && window.location.pathname === '/reset-password';

    const applySessionState = (nextSession: Session | null) => {
      const nextUserId = nextSession?.user?.id ?? null;
      const previousUserId = activeUserIdRef.current;
      if (previousUserId && previousUserId !== nextUserId) {
        clearMessagingSession(previousUserId);
      }
      activeUserIdRef.current = nextUserId;
      primeAuthUserId(nextUserId);
      setCurrentDeviceUserScope(nextUserId);
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      if (!nextSession) updateLoginSecurity({ status: 'signed_out', session: null });
      setLoading(false);
    };

    const clearSessionState = () => {
      const previousUserId = activeUserIdRef.current;
      activeUserIdRef.current = null;
      assessmentRef.current = null;
      pendingPasswordRef.current = null;
      approvedServicesTokenRef.current = null;
      clearMessagingSession(previousUserId);
      primeAuthUserId(null);
      setCurrentDeviceUserScope(null);
      stopSessionGuard();
      clearArchiveMasterKeySession();
      clearAccountKeySession();
      setSession(null);
      setUser(null);
      setLoading(false);
      setCryptoRestoring(false);
      updateLoginSecurity({ status: 'signed_out', session: null });
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

        if (session?.user && !isRecoveryPending()) {
          void ensureLoginSecurity(session).catch(() => undefined);
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
          await ensureLoginSecurity(current.session).catch(() => undefined);
          return;
        }

        // Refresh only when no usable persisted session exists.
        const { data: refreshed } = await supabase.auth.refreshSession();
        applySessionState(refreshed.session);
        if (refreshed.session) await ensureLoginSecurity(refreshed.session).catch(() => undefined);
      } catch {
        // An auth-lock AbortError is transient. onAuthStateChange will deliver
        // the restored session without starting another competing operation.
        setLoading(false);
      }
    };

    void initAuth();
    return () => subscription.unsubscribe();
  }, [ensureLoginSecurity, updateLoginSecurity]);

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
    const rateLimitError = await checkLoginRateLimit(normalizedEmail);
    if (rateLimitError) return { error: rateLimitError };

    setCryptoRestoring(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });
      void recordLoginAttempt(normalizedEmail, !error && Boolean(data.user));

      if (!error && data.user && data.session) {
        // The password is kept in memory only. A suspicious login must be
        // approved before it can restore the account Master Key or enroll a
        // device. If approval arrives while this tab remains open, setup
        // resumes automatically; after a reload the user re-enters the password.
        pendingPasswordRef.current = { userId: data.user.id, password };
        const security = await ensureLoginSecurity(data.session);
        if (security.status === 'approved') {
          await completePendingPasswordSetup(data.user.id);
        }
      }

      return { error };
    } catch (error) {
      pendingPasswordRef.current = null;
      return { error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      setCryptoRestoring(false);
    }
  };

  const signOut = async () => {
    try { stopSessionGuard(); } catch { /* guard may already be stopped */ }
    clearArchiveMasterKeySession();
    clearAccountKeySession();
    clearMessagingSession(activeUserIdRef.current ?? user?.id ?? null);
    activeUserIdRef.current = null;
    pendingPasswordRef.current = null;
    assessmentRef.current = null;
    approvedServicesTokenRef.current = null;
    updateLoginSecurity({ status: 'signed_out', session: null });
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

  const refreshLoginSecurity = useCallback(async (): Promise<void> => {
    const currentSession = session;
    if (!currentSession?.user) {
      updateLoginSecurity({ status: 'signed_out', session: null });
      return;
    }

    try {
      let security = await readCurrentLoginSecuritySession();
      if (security.status === 'unassessed' || security.status === 'expired') {
        security = await ensureLoginSecurity(currentSession);
      } else {
        updateLoginSecurity({ status: security.status, session: security });
      }
      if (security.status === 'approved') {
        startApprovedSessionServices(currentSession);
        await completePendingPasswordSetup(currentSession.user.id);
      }
    } catch (error) {
      if (await isLoginSecurityServerGateOpen()) {
        const rolloutSession: LoginSecuritySession = {
          status: 'approved',
          riskLevel: 'low',
          approvedVia: 'server_gate',
        };
        updateLoginSecurity({ status: 'approved', session: rolloutSession });
        startApprovedSessionServices(currentSession);
        await completePendingPasswordSetup(currentSession.user.id);
        return;
      }
      updateLoginSecurity({
        status: 'error',
        session: loginSecurityRef.current.session,
        errorCode: error instanceof Error ? error.message : 'LOGIN_SECURITY_REQUEST_FAILED',
      });
      throw error;
    }
  }, [
    completePendingPasswordSetup,
    ensureLoginSecurity,
    session,
    startApprovedSessionServices,
    updateLoginSecurity,
  ]);

  const resendLoginApprovalEmail = useCallback(async (): Promise<void> => {
    await resendLoginSecurityEmail();
    await refreshLoginSecurity();
  }, [refreshLoginSecurity]);

  return (
    <AuthContext.Provider value={{
      user,
      session,
      loading,
      cryptoRestoring,
      loginSecurity,
      signUp,
      signIn,
      signOut,
      refreshLoginSecurity,
      resendLoginApprovalEmail,
    }}>
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
