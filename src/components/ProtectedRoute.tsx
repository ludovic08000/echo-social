import { useState, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useProfile } from '@/hooks/useProfile';
import { AgeFlaggedScreen } from '@/components/AgeFlaggedScreen';
import { supabase } from '@/integrations/supabase/client';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const [isRecovery, setIsRecovery] = useState(false);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsRecovery(true);
      }
    });
    // Also check URL hash on mount
    if (window.location.hash.includes('type=recovery')) {
      setIsRecovery(true);
    }
    return () => subscription.unsubscribe();
  }, []);

  // If user landed via password recovery link, force them to reset password
  if (isRecovery && location.pathname !== '/reset-password') {
    return <Navigate to="/reset-password" replace />;
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

  // If already authenticated, redirect to feed
  if (user) {
    const from = (location.state as { from?: string })?.from || '/feed';
    return <Navigate to={from} replace />;
  }

  return <>{children}</>;
}
