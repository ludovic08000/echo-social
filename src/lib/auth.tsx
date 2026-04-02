import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { generateFingerprint } from '@/hooks/useTrustAndSafety';
import { startSessionGuard, stopSessionGuard } from '@/lib/sessionGuard';
import { setRecoveryFlag, isRecoveryPending } from '@/components/ProtectedRoute';

/** Check URL hash for recovery tokens BEFORE any session is exposed */
function detectRecoveryFromHash(): boolean {
  const hash = window.location.hash;
  if (hash.includes('type=recovery')) {
    setRecoveryFlag();
    return true;
  }
  return false;
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
  const [recoveryMode, setRecoveryMode] = useState(initialRecovery);

  useEffect(() => {
    // Get session first for fastest possible auth resolution
    supabase.auth.getSession().then(({ data: { session } }) => {
      // If recovery is pending, expose user but ProtectedRoute will redirect
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        // Intercept recovery at the earliest point
        if (event === 'PASSWORD_RECOVERY') {
          setRecoveryFlag();
          setRecoveryMode(true);
        }

        setSession(session);
        setUser(session?.user ?? null);
        setLoading(false);

        // Session guard: start on sign in, stop on sign out
        if (event === 'SIGNED_IN' && session?.user) {
          // Don't start session guard or fingerprint in recovery mode
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

        if (event === 'SIGNED_OUT') {
          setRecoveryMode(false);
          stopSessionGuard();
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, name: string, dateOfBirth?: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        data: { name, date_of_birth: dateOfBirth },
      },
    });
    return { error };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
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
