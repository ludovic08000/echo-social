import { useState, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useProfile } from '@/hooks/useProfile';
import { AgeFlaggedScreen } from '@/components/AgeFlaggedScreen';
import { supabase } from '@/integrations/supabase/client';
import { detectAndStoreRecoveryFromHash, isRecoveryPending, setRecoveryFlag } from '@/lib/authRecovery';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const [recoveryDetected, setRecoveryDetected] = useState(() => isRecoveryPending() || detectAndStoreRecoveryFromHash());

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryFlag();
        setRecoveryDetected(true);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // Re-check sessionStorage on every render (covers navigation)
  useEffect(() => {
    if (isRecoveryPending() && !recoveryDetected) {
      setRecoveryDetected(true);
    }
  }, [location.pathname, recoveryDetected]);

  // If recovery is pending, FORCE to reset-password — no exceptions
  if (recoveryDetected || isRecoveryPending()) {
    if (location.pathname !== '/reset-password') {
      return <Navigate to="/reset-password" replace />;
    }
  }

  // Show loading state
  if (loading || (user && profileLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-pulse-gradient animate-pulse-slow" />
          <span className="text-muted-foreground">Chargement...</span>
        </div>
      </div>
    );
  }

  // If not authenticated and trying to access protected route
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  // If age verification flagged, show blocking screen (except on onboarding)
  if (profile && (profile.age_verification_status === 'flagged' || profile.age_verification_status === 'pending') && location.pathname !== '/onboarding') {
    return <AgeFlaggedScreen />;
  }

  return <>{children}</>;
}

export function PublicOnlyRoute({ children }: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (isRecoveryPending() || detectAndStoreRecoveryFromHash()) {
    return <Navigate to="/reset-password" replace />;
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-pulse-gradient animate-pulse-slow" />
          <span className="text-muted-foreground">Chargement...</span>
        </div>
      </div>
    );
  }

  // If already authenticated, redirect to feed — but NOT during recovery
  if (user && !isRecoveryPending()) {
    const from = (location.state as { from?: string })?.from || '/feed';
    return <Navigate to={from} replace />;
  }

  return <>{children}</>;
}
