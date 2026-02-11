import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import forsureLogo from '@/assets/forsure-logo.png';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/hooks/use-toast';

export default function Signup() {
  const navigate = useNavigate();
  const { signUp, user } = useAuth();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);

  if (user) {
    navigate('/feed');
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!acceptedTerms || !acceptedPrivacy) {
      toast({
        title: 'Conditions requises',
        description: 'Veuillez accepter les CGU et la politique de confidentialité pour continuer.',
        variant: 'destructive',
      });
      return;
    }
    
    if (password.length < 6) {
      toast({
        title: t('signup.passwordTooShort'),
        description: t('signup.passwordMinLength'),
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);

    const { error } = await signUp(email, password, name);

    if (error) {
      toast({
        title: t('common.error'),
        description: error.message,
        variant: 'destructive',
      });
      setIsLoading(false);
      return;
    }

    toast({
      title: t('signup.welcome'),
      description: t('signup.welcomeDesc'),
    });
    navigate('/feed');
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link to="/" className="flex items-center justify-center gap-2 mb-8">
          <img src={forsureLogo} alt="Forsure.fans" className="w-10 h-10 rounded-xl" />
          <span className="text-2xl font-bold text-gradient">Forsure.fans</span>
        </Link>

        <div className="pulse-card p-6 sm:p-8">
          <h1 className="text-2xl font-bold text-center mb-6">{t('signup.title')}</h1>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('signup.name')}</Label>
              <Input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('signup.namePlaceholder')}
                className="pulse-input"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">{t('signup.email')}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('signup.emailPlaceholder')}
                className="pulse-input"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{t('signup.password')}</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('signup.passwordPlaceholder')}
                  className="pulse-input pr-10"
                  required
                  minLength={6}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Legal checkboxes */}
            <div className="space-y-3 pt-2">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="terms"
                  checked={acceptedTerms}
                  onCheckedChange={(v) => setAcceptedTerms(v === true)}
                  className="mt-0.5"
                />
                <label htmlFor="terms" className="text-sm text-muted-foreground leading-tight cursor-pointer">
                  J'ai lu et j'accepte les{' '}
                  <Link to="/legal/terms" className="text-primary hover:underline" target="_blank">
                    Conditions Générales d'Utilisation
                  </Link>
                </label>
              </div>

              <div className="flex items-start gap-3">
                <Checkbox
                  id="privacy"
                  checked={acceptedPrivacy}
                  onCheckedChange={(v) => setAcceptedPrivacy(v === true)}
                  className="mt-0.5"
                />
                <label htmlFor="privacy" className="text-sm text-muted-foreground leading-tight cursor-pointer">
                  J'ai lu et j'accepte la{' '}
                  <Link to="/legal/privacy" className="text-primary hover:underline" target="_blank">
                    Politique de Confidentialité
                  </Link>
                </label>
              </div>
            </div>

            <Button
              type="submit"
              disabled={isLoading || !acceptedTerms || !acceptedPrivacy}
              className="pulse-button-gradient w-full"
            >
              {isLoading ? t('signup.submitting') : t('signup.submit')}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t('signup.hasAccount')}{' '}
            <Link to="/login" className="pulse-link font-medium">
              {t('signup.loginLink')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
