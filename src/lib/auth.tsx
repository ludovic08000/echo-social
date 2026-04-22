import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { generateFingerprint } from '@/hooks/useTrustAndSafety';
import { startSessionGuard, stopSessionGuard } from '@/lib/sessionGuard';
import { detectAndStoreRecoveryFromHash, isRecoveryPending, setRecoveryFlag } from '@/lib/authRecovery';
import { getSafeRedirectUrl } from '@/lib/urlUtils';
import { initAccountKeySync } from '@/lib/crypto/accountKeyBackup';

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

// Detect recovery from URL hash synchronously at module load
const initialRecovery = detectRecoveryFromHash() || isRecoveryPending();

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
          return;
        }

        const { data: current } = await supabase.auth.getSession();
        applySessionState(current.session);
      } catch {
        const { data: current } = await supabase.auth.getSession();
        applySessionState(current.session);
      }
    };

    void initAuth();

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, name: string, dateOfBirth?: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: getSafeRedirectUrl('/auth/confirm'),
        data: { name, date_of_birth: dateOfBirth },
      },
    });
    // Initialize account key sync immediately so backups can occur as soon as keys exist
    if (!error && data.user) {
      initAccountKeySync(password, data.user.id).catch(() => {});
    }
    return { error };
  };

  const signIn = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    // Auto-restore E2EE keys from server backup using password
    if (!error && data.user) {
      initAccountKeySync(password, data.user.id).then((status) => {
        console.log('[AUTH] Key sync status:', status);
      }).catch((e) => console.warn('[AUTH] Key sync failed:', e));
    }
    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
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
