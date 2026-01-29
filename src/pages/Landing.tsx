import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Zap } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (user) {
    navigate('/feed');
    return null;
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <Zap className="w-8 h-8 text-primary" />
          <span className="text-2xl font-bold text-gradient">Pulse</span>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/login">
            <Button variant="ghost" className="font-medium">
              Se connecter
            </Button>
          </Link>
          <Link to="/signup">
            <Button className="pulse-button-gradient">
              S'inscrire
            </Button>
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-foreground mb-6 animate-fade-in">
            Partagez vos moments.
            <br />
            <span className="text-gradient">Connectez-vous.</span>
          </h1>
          
          <p className="text-lg sm:text-xl text-muted-foreground mb-10 max-w-xl mx-auto animate-slide-up">
            Un réseau social épuré, sans distractions. 
            Concentrez-vous sur ce qui compte vraiment.
          </p>
          
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-slide-up">
            <Link to="/signup">
              <Button size="lg" className="pulse-button-gradient text-lg px-8 py-6">
                Commencer maintenant
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
          </div>

          {/* Features */}
          <div className="mt-20 grid grid-cols-1 sm:grid-cols-3 gap-8">
            <FeatureCard
              title="Simple"
              description="Interface épurée, sans publicité ni algorithme intrusif"
            />
            <FeatureCard
              title="Authentique"
              description="Partagez de vraies pensées avec de vraies personnes"
            />
            <FeatureCard
              title="Respectueux"
              description="Vos données vous appartiennent, toujours"
            />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="px-6 py-8 text-center text-muted-foreground text-sm">
        <p>© 2024 Pulse. Fait avec ❤️</p>
      </footer>
    </div>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="pulse-card p-6 text-center">
      <h3 className="font-semibold text-foreground mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
