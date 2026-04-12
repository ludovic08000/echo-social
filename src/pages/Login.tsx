import { useState, useEffect } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { checkLoginAllowed, recordFailedLogin, resetLoginAttempts } from '@/lib/loginRateLimit';
import loginBg from '@/assets/login-bg.png';

export default function Login() {
  const location = useLocation();
  const { signIn, user } = useAuth();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lockoutSeconds, setLockoutSeconds] = useState(() => checkLoginAllowed());

  // Countdown timer for lockout
  useEffect(() => {
    if (lockoutSeconds <= 0) return;
    const timer = setInterval(() => {
      const remaining = checkLoginAllowed();
      setLockoutSeconds(remaining);
      if (remaining <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [lockoutSeconds]);

  if (user) {
    const from = (location.state as { from?: string })?.from || '/feed';
    return <Navigate to={from} replace />;
  }

  const queryClient = useQueryClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Rate limit check
    const blocked = checkLoginAllowed();
    if (blocked > 0) {
      setLockoutSeconds(blocked);
      toast({
        title: 'Trop de tentatives',
        description: `Réessayez dans ${blocked} secondes.`,
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);
    const { error } = await signIn(email, password);

    if (error) {
      const lockout = recordFailedLogin();
      toast({
        title: t('login.error'),
        description: lockout > 0
          ? `Compte temporairement verrouillé. Réessayez dans ${lockout}s.`
          : t('login.errorDesc'),
        variant: 'destructive',
      });
      if (lockout > 0) setLockoutSeconds(lockout);
      setIsLoading(false);
      return;
    }

    resetLoginAttempts();
    queryClient.removeQueries({ queryKey: ['posts', 'friends-feed'] });
    setIsLoading(false);
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
          <h1 className="text-2xl font-bold text-center mb-6">{t('login.title')}</h1>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t('login.email')}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('login.emailPlaceholder')}
                className="bg-background/50 border-border/50"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{t('login.password')}</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('login.passwordPlaceholder')}
                  className="bg-background/50 border-border/50 pr-10"
                  required
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

            <Button
              type="submit"
              disabled={isLoading || lockoutSeconds > 0}
              className="w-full"
            >
              {lockoutSeconds > 0
                ? `Verrouillé (${lockoutSeconds}s)`
                : isLoading ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <Link to="/forgot-password" className="text-sm text-primary hover:underline">
              Mot de passe oublié ?
            </Link>
          </div>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('login.noAccount')}{' '}
            <Link to="/signup" className="text-primary hover:underline font-medium">
              {t('login.signupLink')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
