import { Link } from 'react-router-dom';
import { Zap, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import Feed from './Feed';
import loginBg from '@/assets/login-bg.png';

export default function Landing() {
  const { user, loading } = useAuth();

  // If user is authenticated, show the feed directly
  if (user) {
    return <Feed />;
  }

  // Show loading state while checking auth
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Zap className="w-12 h-12 text-gold animate-pulse" />
          <p className="text-muted-foreground">Chargement...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative flex flex-col overflow-hidden">
      {/* Background image with fade overlay */}
      <div 
        className="absolute inset-0 bg-cover bg-bottom bg-no-repeat animate-fade-in"
        style={{ backgroundImage: `url(${loginBg})`, backgroundPosition: 'center 30%' }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-background/40" />

      {/* Content */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-16">
        <div className="max-w-md mx-auto text-center animate-fade-in">
          {/* Logo */}
          <div className="flex items-center justify-center gap-2 mb-8">
            <Zap className="w-12 h-12 text-gold" />
            <span className="text-4xl font-display font-bold text-gradient-gold">Pulse</span>
          </div>
          
          <h1 className="text-3xl sm:text-4xl font-display font-bold tracking-tight text-foreground mb-4">
            Partagez vos moments.
            <br />
            <span className="text-gradient-gold">Connectez-vous.</span>
          </h1>
          
          <p className="text-muted-foreground mb-10 max-w-sm mx-auto">
            Un réseau social épuré et élégant, sans distractions.
          </p>
          
          <div className="flex flex-col gap-3 max-w-xs mx-auto">
            <Link to="/signup">
              <Button size="lg" className="w-full premium-button">
                <Sparkles className="w-4 h-4 mr-2" />
                S'inscrire
              </Button>
            </Link>
            <Link to="/login">
              <Button size="lg" variant="outline" className="w-full border-border/50 bg-background/30 backdrop-blur-sm hover:bg-background/50">
                Se connecter
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
