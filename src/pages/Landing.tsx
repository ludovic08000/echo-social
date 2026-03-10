import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
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
          <BrandLogo className="h-10 w-auto animate-pulse" />
          <p className="text-muted-foreground">Chargement...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative flex flex-col overflow-hidden">
      {/* Background image with fade overlay */}
      <div 
        className="absolute inset-0 bg-no-repeat bg-cover animate-fade-in"
        style={{ backgroundImage: `url(${loginBg})`, backgroundPosition: 'center 25%' }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-background/40" />

      {/* Content */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-16">
        <div className="max-w-md mx-auto text-center animate-fade-in">
          {/* Logo */}
          <div className="flex items-center justify-center mb-10">
            <BrandLogo className="h-20 sm:h-28 md:h-32 w-auto drop-shadow-[0_0_40px_hsl(220,70%,50%,0.5)]" />
          </div>
          
          <h1 className="text-3xl sm:text-4xl font-display font-bold tracking-tight text-foreground mb-4">
            Partagez vos moments.
            <br />
            <span className="text-gradient-gold">Connectez-vous.</span>
          </h1>
          
          <p className="text-muted-foreground mb-8 max-w-sm mx-auto">
            Le réseau social éthique, sans tracking. Créez vos canaux TV.
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

      {/* Footer — visible, crawlable links for Google compliance */}
      <footer className="relative z-10 w-full border-t border-border bg-background/80 backdrop-blur-md py-8 px-6">
        <nav className="max-w-3xl mx-auto flex flex-col items-center gap-4">
          <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-6">
            <a href="https://forsure.fans/privacy" className="text-base font-semibold text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
              🔒 Politique de confidentialité
            </a>
            <a href="https://forsure.fans/legal" className="text-base font-semibold text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
              📜 Conditions Générales d'Utilisation
            </a>
          </div>
          <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} Forsure — Contact : <a href="mailto:dpo@forsure.fans" className="underline">dpo@forsure.fans</a></p>
        </nav>
      </footer>
    </div>
  );
}
