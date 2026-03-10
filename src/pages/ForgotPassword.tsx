import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Mail, Send } from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import loginBg from '@/assets/login-bg.png';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    const siteUrl = window.location.hostname.includes('forsure.fans')
      ? 'https://forsure.fans'
      : window.location.origin;

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl}/reset-password`,
    });

    setIsLoading(false);

    if (error) {
      console.error('Password reset error:', error.message, error.status);
      const isRateLimit = error.message?.toLowerCase().includes('rate') || error.status === 429;
      toast({
        title: isRateLimit ? 'Trop de tentatives' : 'Erreur',
        description: isRateLimit
          ? 'Veuillez patienter quelques minutes avant de réessayer.'
          : "Impossible d'envoyer l'e-mail de réinitialisation. Vérifiez votre adresse.",
        variant: 'destructive',
      });
      return;
    }

    setSent(true);
    toast({
      title: 'E-mail envoyé ✉️',
      description: 'Consultez votre boîte de réception pour réinitialiser votre mot de passe.',
    });
  };

  return (
    <div className="min-h-screen relative flex items-center justify-center px-4 overflow-hidden">
      <div
        className="absolute inset-0 bg-no-repeat bg-cover animate-fade-in"
        style={{ backgroundImage: `url(${loginBg})`, backgroundPosition: 'center 25%' }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-background/40" />

      <div className="relative z-10 w-full max-w-sm animate-fade-in">
        <Link to="/" className="flex items-center justify-center mb-8">
          <BrandLogo className="h-12 sm:h-14 w-auto drop-shadow-[0_0_20px_hsl(220,70%,50%,0.3)]" />
        </Link>

        <div className="backdrop-blur-xl bg-card/60 border border-border/50 rounded-2xl p-6 sm:p-8 shadow-2xl">
          <Link to="/login">
            <Button variant="ghost" size="sm" className="mb-4 -ml-2">
              <ArrowLeft className="w-4 h-4 mr-2" /> Retour à la connexion
            </Button>
          </Link>

          <h1 className="text-2xl font-bold text-center mb-2">Mot de passe oublié</h1>
          <p className="text-sm text-muted-foreground text-center mb-6">
            Entrez votre adresse e-mail et nous vous enverrons un lien pour réinitialiser votre mot de passe.
          </p>

          {sent ? (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                <Mail className="w-8 h-8 text-primary" />
              </div>
              <p className="text-foreground font-medium">E-mail envoyé !</p>
              <p className="text-sm text-muted-foreground">
                Un lien de réinitialisation a été envoyé à <strong>{email}</strong>. Vérifiez vos spams si vous ne le trouvez pas.
              </p>
              <Button variant="outline" onClick={() => setSent(false)} className="mt-4">
                Renvoyer l'e-mail
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Adresse e-mail</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="votre@email.com"
                  className="bg-background/50 border-border/50"
                  required
                />
              </div>

              <Button type="submit" disabled={isLoading} className="w-full">
                {isLoading ? (
                  'Envoi en cours...'
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-2" /> Envoyer le lien
                  </>
                )}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
