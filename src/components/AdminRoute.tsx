import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Shield } from 'lucide-react';
import { useIsAdmin } from '@/hooks/useIsAdmin';

export function AdminRoute({ children }: { children: ReactNode }) {
  const { data: isAdmin, isLoading, isError } = useIsAdmin();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Shield className="w-8 h-8 text-primary animate-pulse" aria-hidden="true" />
          <span className="text-sm">Vérification de l’accès interne…</span>
        </div>
      </div>
    );
  }

  // Fail closed: an authorization lookup failure never exposes the console.
  if (isError || !isAdmin) return <Navigate to="/feed" replace />;
  return <>{children}</>;
}

