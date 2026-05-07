import { useState, useEffect } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock, ShieldCheck, MessageCircle, Network } from 'lucide-react';
import forsureBanner from '@/assets/forsure-loader.png';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { checkLoginAllowed, recordFailedLogin, resetLoginAttempts } from '@/lib/loginRateLimit';
import { initAccountKeySync } from '@/lib/crypto/accountKeyBackup';

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

    // Auto-sync E2EE keys from server backup (Google-style)
    try {
      const { data: { user: authUser } } = await (await import('@/integrations/supabase/client')).supabase.auth.getUser();
      if (authUser) {
        const result = await initAccountKeySync(password, authUser.id);
        if (result === 'restored') {
          toast({ title: '🔑 Clés E2EE restaurées automatiquement' });
        }
      }
    } catch (e) {
      console.warn('[Login] Key sync failed:', e);
    }

    setIsLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50/40 flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-md animate-fade-in">
        {/* Unified card: brand banner + login form */}
        <div className="w-full bg-white rounded-3xl shadow-[0_20px_60px_-20px_rgba(0,35,149,0.25)] border border-slate-100 overflow-hidden">
          <Link to="/" className="flex w-full items-center justify-center bg-gradient-to-b from-white to-slate-50/60 pt-8 pb-4">
            <img
              src={forsureBanner}
              alt="Forsure — Connecter · Partager · Avancer"
              className="h-40 w-auto select-none object-contain"
              draggable={false}
            />
          </Link>

          <div className="px-6 sm:px-8 pt-2 pb-7 sm:pb-8">
            <h1 className="text-2xl font-bold text-center text-slate-900 mb-6">
              {t('login.title')}
            </h1>


          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-slate-900 font-medium">
                {t('login.email')}
              </Label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="vous@exemple.com"
                  className="h-14 pl-12 rounded-2xl bg-white border-slate-200 text-slate-900 placeholder:text-slate-400 focus-visible:ring-primary"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-slate-900 font-medium">
                {t('login.password')}
              </Label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="h-14 pl-12 pr-12 rounded-2xl bg-white border-slate-200 text-slate-900 placeholder:text-slate-400 focus-visible:ring-primary"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={isLoading || lockoutSeconds > 0}
              className="w-full h-14 rounded-2xl text-base font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_8px_24px_rgba(37,99,235,0.35)]"
            >
              {lockoutSeconds > 0
                ? `Verrouillé (${lockoutSeconds}s)`
                : isLoading ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <Link to="/forgot-password" className="text-sm font-medium text-primary hover:underline">
              Mot de passe oublié ?
            </Link>
          </div>

          <div className="my-5 flex items-center gap-3">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-sm text-slate-400">ou</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          <p className="text-center text-sm text-slate-500">
            Pas encore de compte ?{' '}
            <Link to="/signup" className="text-primary hover:underline font-semibold">
              S'inscrire
            </Link>
          </p>

          {/* Trust badges fused into the bottom of the card */}
          <div className="mt-7 pt-5 border-t border-slate-100 grid grid-cols-3 gap-2 text-center">
            {[
              { Icon: ShieldCheck, label: 'Messagerie\nsécurisée' },
              { Icon: MessageCircle, label: 'Bien-être' },
              { Icon: Network, label: 'Réseau\nintelligent' },
            ].map(({ Icon, label }, i) => (
              <div key={i} className={`flex flex-col items-center gap-2 ${i < 2 ? 'border-r border-slate-100' : ''}`}>
                <Icon className="w-6 h-6 text-[#0a1f4a]" strokeWidth={1.5} />
                <span className="text-[10px] font-semibold tracking-wider uppercase text-slate-700 leading-tight whitespace-pre-line">{label}</span>
              </div>
            ))}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

