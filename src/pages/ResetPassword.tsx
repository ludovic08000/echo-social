import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Lock, CheckCircle } from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import PasswordStrength from '@/components/PasswordStrength';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { clearRecoveryFlag, detectAndStoreRecoveryFromHash, isRecoveryPending, setRecoveryFlag } from '@/lib/authRecovery';
import { initAccountKeySync, syncBackupToServer } from '@/lib/crypto/accountKeyBackup';
import loginBg from '@/assets/login-bg.png';

export default function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const [isRecovery, setIsRecovery] = useState(() => {
    const detected = detectAndStoreRecoveryFromHash();
    return isRecoveryPending() || detected;
  });

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryFlag();
        setIsRecovery(true);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password.length < 10) {
      toast({
        title: 'Mot de passe trop court',
        description: 'Le mot de passe doit contenir au moins 10 caractères.',
        variant: 'destructive',
      });
      return;
    }

    const COMMON_PASSWORDS = [
      'password', '123456', '12345678', 'qwerty', 'abc123', 'monkey', 'master',
      'dragon', 'login', 'princess', 'football', 'shadow', 'sunshine', 'trustno1',
      'iloveyou', 'batman', 'access', 'hello', 'charlie', 'forsure', 'azerty',
      'motdepasse', 'bonjour', 'soleil', 'amour', 'bienvenue', '000000', '1234567890',
    ];
    if (COMMON_PASSWORDS.includes(password.toLowerCase())) {
      toast({
        title: 'Mot de passe trop commun',
        description: 'Choisissez un mot de passe unique et personnel.',
        variant: 'destructive',
      });
      return;
    }

    const hasUpper = /[A-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);
    let strength = 0;
    if (password.length >= 10) strength++;
    if (password.length >= 14) strength++;
    if (hasUpper) strength++;
    if (hasNumber) strength++;
    if (hasSpecial) strength++;
    if (strength < 3) {
      toast({
        title: 'Mot de passe trop faible',
        description: 'Ajoutez des majuscules, des chiffres ou des caractères spéciaux.',
        variant: 'destructive',
      });
      return;
    }

    if (password !== confirmPassword) {
      toast({
        title: 'Erreur',
        description: 'Les mots de passe ne correspondent pas.',
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setIsLoading(false);
      const msg = (error.message || '').toLowerCase();
      const isSamePassword = msg.includes('same') || msg.includes('different') || msg.includes('previously used') || msg.includes('cannot be updated') || msg.includes('identity');
      toast({
        title: isSamePassword ? '⚠️ Ancien mot de passe détecté' : 'Erreur',
        description: isSamePassword
          ? 'Vous avez utilisé un ancien mot de passe. Pour votre sécurité, veuillez en créer un tout nouveau, différent des précédents.'
          : 'Impossible de mettre à jour le mot de passe. Le lien a peut-être expiré.',
        variant: 'destructive',
      });
      return;
    }

    // Re-bind the account E2EE backup to the NEW password before signing out.
    // Without this, the Supabase password changes but the encrypted key backup
    // can remain wrapped with the old password, breaking future restores.
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.id) {
        const status = await initAccountKeySync(password, user.id);
        if (status === 'local_ok' || status === 'restored') {
          await syncBackupToServer();
        } else {
          console.warn('[ResetPassword][E2EE] backup rewrap skipped:', status);
        }
      }
    } catch (e) {
      console.warn('[ResetPassword][E2EE] backup rewrap failed:', e);
    }

    setIsLoading(false);
    setSuccess(true);
    toast({
      title: 'Mot de passe modifié ✅',
      description: 'Votre mot de passe a été mis à jour. Veuillez vous reconnecter.',
    });

    await supabase.auth.signOut();
    clearRecoveryFlag();
    window.history.replaceState(null, document.title, '/reset-password');

    setTimeout(() => {
      navigate('/login', { replace: true });
    }, 2000);
  };

  if (!isRecovery && !success) {
    return (
      <div className="min-h-screen relative flex items-center justify-center px-4 overflow-hidden">
        <div
          className="absolute inset-0 bg-no-repeat bg-cover"
          style={{ backgroundImage: `url(${loginBg})`, backgroundPosition: 'center 25%' }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-background/40" />

        <div className="relative z-10 w-full max-w-sm text-center">
          <BrandLogo className="h-12 w-auto mx-auto mb-8" />
          <div className="backdrop-blur-xl bg-card/60 border border-border/50 rounded-2xl p-6 sm:p-8 shadow-2xl">
            <Lock className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h1 className="text-xl font-bold mb-2">Lien invalide ou expiré</h1>
            <p className="text-sm text-muted-foreground mb-6">
              Ce lien de réinitialisation n'est plus valide. Demandez-en un nouveau.
            </p>
            <Link to="/forgot-password">
              <Button className="w-full" onClick={async (e) => {
                e.preventDefault();
                clearRecoveryFlag();
                await supabase.auth.signOut();
                window.location.href = '/forgot-password';
              }}>Demander un nouveau lien</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

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
          {success ? (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto">
                <CheckCircle className="w-8 h-8 text-green-500" />
              </div>
              <h1 className="text-xl font-bold">Mot de passe modifié !</h1>
              <p className="text-sm text-muted-foreground">
                Vous allez être redirigé automatiquement...
              </p>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-center mb-2">Nouveau mot de passe</h1>
              <p className="text-sm text-muted-foreground text-center mb-6">
                Choisissez un nouveau mot de passe sécurisé.
              </p>
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 mb-4">
                <p className="text-xs text-primary text-center">
                  ⚠️ Vous devez choisir un mot de passe <strong>différent</strong> de l'ancien.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">Nouveau mot de passe</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Minimum 10 caractères"
                      className="bg-background/50 border-border/50 pr-10"
                      required
                      minLength={10}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <PasswordStrength password={password} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirmer le mot de passe</Label>
                  <Input
                    id="confirmPassword"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Retapez votre mot de passe"
                    className="bg-background/50 border-border/50"
                    required
                    minLength={10}
                  />
                </div>

                <Button type="submit" disabled={isLoading} className="w-full">
                  {isLoading ? 'Mise à jour...' : 'Mettre à jour le mot de passe'}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
