import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import Landing from './Landing';

const Index = () => {
  const { user, loading } = useAuth();

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

  if (user) {
    return <Navigate to="/feed" replace />;
  }

  return <Landing />;
};

export default Index;
