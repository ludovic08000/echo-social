import { Link, Navigate } from 'react-router-dom';
import { ArrowRight, Zap, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import Feed from './Feed';

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
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Zap className="w-8 h-8 text-gold" />
          <span className="text-2xl font-display font-bold text-gradient-gold">Pulse</span>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/login">
            <Button variant="ghost" className="font-medium hover:text-gold transition-colors">
              Se connecter
            </Button>
          </Link>
          <Link to="/signup">
            <Button className="premium-button">
              <Sparkles className="w-4 h-4 mr-2" />
              S'inscrire
            </Button>
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gold/10 border border-gold/20 text-gold text-sm mb-8 animate-fade-in">
            <Sparkles className="w-4 h-4" />
            <span>Réseau social nouvelle génération</span>
          </div>
          
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-display font-bold tracking-tight text-foreground mb-6 animate-fade-in">
            Partagez vos moments.
            <br />
            <span className="text-gradient-gold">Connectez-vous.</span>
          </h1>
          
          <p className="text-lg sm:text-xl text-muted-foreground mb-10 max-w-xl mx-auto animate-slide-up">
            Un réseau social épuré et élégant, sans distractions. 
            Vivez une expérience premium avec des mises à jour en temps réel.
          </p>
          
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-slide-up">
            <Link to="/signup">
              <Button size="lg" className="premium-button text-lg px-8 py-6 group">
                Commencer maintenant
                <ArrowRight className="ml-2 w-5 h-5 transition-transform group-hover:translate-x-1" />
              </Button>
            </Link>
            <Link to="/login">
              <Button size="lg" variant="outline" className="text-lg px-8 py-6 border-gold/30 hover:bg-gold/10 hover:border-gold/50">
                J'ai déjà un compte
              </Button>
            </Link>
          </div>

          {/* Features */}
          <div className="mt-20 grid grid-cols-1 sm:grid-cols-3 gap-6">
            <FeatureCard
              icon="⚡"
              title="Temps Réel"
              description="Voyez les publications de vos amis instantanément, sans rafraîchir"
            />
            <FeatureCard
              icon="✨"
              title="Premium"
              description="Design luxueux et fonctionnalités exclusives"
            />
            <FeatureCard
              icon="🔒"
              title="Respectueux"
              description="Vos données vous appartiennent, toujours"
            />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="px-6 py-8 text-center text-muted-foreground text-sm border-t border-border/50">
        <p>© 2024 Pulse. Fait avec ❤️</p>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div className="premium-card p-6 text-center group hover:border-gold/40 transition-all duration-300">
      <div className="text-3xl mb-3 group-hover:scale-110 transition-transform">{icon}</div>
      <h3 className="font-display font-semibold text-foreground mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
