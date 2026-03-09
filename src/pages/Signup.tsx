import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Shield } from 'lucide-react';
import { differenceInYears } from 'date-fns';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';

export default function Signup() {
  const navigate = useNavigate();
  const { signUp, user } = useAuth();
  const { t } = useTranslation();
  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState<Date>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [showParentalStep, setShowParentalStep] = useState(false);
  const [parentalPin, setParentalPin] = useState('');
  const [parentalPinConfirm, setParentalPinConfirm] = useState('');
  const [showParentalPin, setShowParentalPin] = useState(false);

  if (user) {
    return <Navigate to="/feed" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!lastName.trim() || !firstName.trim()) {
      toast({
        title: 'Champs requis',
        description: 'Le nom et le prénom sont obligatoires.',
        variant: 'destructive',
      });
      return;
    }

    if (!dateOfBirth) {
      toast({
        title: 'Date de naissance requise',
        description: 'Veuillez indiquer votre date de naissance.',
        variant: 'destructive',
      });
      return;
    }

    // Check minimum age (13 years)
    const today = new Date();
    const age = differenceInYears(today, dateOfBirth);
    const minDate = new Date(today.getFullYear() - 13, today.getMonth(), today.getDate());
    if (dateOfBirth > minDate) {
      toast({
        title: 'Âge minimum requis',
        description: 'Vous devez avoir au moins 13 ans pour vous inscrire.',
        variant: 'destructive',
      });
      return;
    }

    // If under 16, show parental control step first
    const isMinor = age < 16;
    if (isMinor && !showParentalStep) {
      setShowParentalStep(true);
      return;
    }

    // Validate parental PIN if minor
    if (isMinor && showParentalStep) {
      if (parentalPin.length < 8 || !/^\d{8,12}$/.test(parentalPin)) {
        toast({ title: 'Code invalide', description: 'Le code parental doit être composé de 8 chiffres minimum', variant: 'destructive' });
        return;
      }
      if (parentalPin !== parentalPinConfirm) {
        toast({ title: 'Les codes ne correspondent pas', variant: 'destructive' });
        return;
      }
    }

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

    const fullName = `${firstName.trim()} ${lastName.trim()}`;
    const dobString = format(dateOfBirth, 'yyyy-MM-dd');
    const { error } = await signUp(email, password, fullName, dobString);

    if (error) {
      toast({
        title: t('common.error'),
        description: error.message,
        variant: 'destructive',
      });
      setIsLoading(false);
      return;
    }

    // Save parental control if minor — PIN is hashed server-side
    const userAge = differenceInYears(new Date(), dateOfBirth);
    if (userAge < 16 && parentalPin) {
      try {
        const { data: { user: newUser } } = await supabase.auth.getUser();
        if (newUser) {
          await supabase.functions.invoke('verify-parental-pin', {
            body: {
              action: 'set',
              pin: parentalPin,
              allowed_categories: ['education', 'sport', 'gaming', 'musique', 'art', 'humour'],
            },
          });
        }
      } catch (e) {
        console.warn('Failed to save parental control', e);
      }
    }

    toast({
      title: t('signup.welcome'),
      description: t('signup.welcomeDesc'),
    });
    navigate('/onboarding');
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link to="/" className="flex items-center justify-center mb-8">
          <BrandLogo className="h-12 sm:h-14 w-auto drop-shadow-[0_0_20px_hsl(220,70%,50%,0.3)]" />
        </Link>

        <div className="pulse-card p-6 sm:p-8">
          <h1 className="text-2xl font-bold text-center mb-6">{t('signup.title')}</h1>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="lastName">Nom *</Label>
                <Input
                  id="lastName"
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Dupont"
                  className="pulse-input"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="firstName">Prénom *</Label>
                <Input
                  id="firstName"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Jean"
                  className="pulse-input"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Date de naissance *</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal pulse-input",
                      !dateOfBirth && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {dateOfBirth ? format(dateOfBirth, "d MMMM yyyy", { locale: fr }) : "Sélectionner une date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dateOfBirth}
                    onSelect={setDateOfBirth}
                    disabled={(date) =>
                      date > new Date() || date < new Date("1900-01-01")
                    }
                    defaultMonth={new Date(2000, 0)}
                    captionLayout="dropdown-buttons"
                    fromYear={1920}
                    toYear={new Date().getFullYear()}
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">{t('signup.email')} *</Label>
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
              <Label htmlFor="password">{t('signup.password')} *</Label>
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

            {/* Parental control step for minors */}
            {showParentalStep && (
              <div className="space-y-3 p-4 rounded-xl bg-pink-500/5 border border-pink-500/20 animate-fade-in">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Shield className="w-4 h-4 text-pink-500" />
                  Protection parentale
                </div>
                <p className="text-xs text-muted-foreground">
                  L'utilisateur a moins de 16 ans. Un parent doit définir un code PIN à 8 chiffres minimum pour le contrôle parental.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Code PIN</Label>
                    <Input
                      type={showParentalPin ? 'text' : 'password'}
                      value={parentalPin}
                      onChange={(e) => setParentalPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
                      placeholder="8 chiffres min."
                      maxLength={12}
                      className="text-center text-lg tracking-[0.3em] font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Confirmer</Label>
                    <Input
                      type={showParentalPin ? 'text' : 'password'}
                      value={parentalPinConfirm}
                      onChange={(e) => setParentalPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 12))}
                      placeholder="8 chiffres min."
                      maxLength={12}
                      className="text-center text-lg tracking-[0.3em] font-mono"
                    />
                  </div>
                </div>
                <button type="button" onClick={() => setShowParentalPin(!showParentalPin)} className="text-xs text-primary hover:underline">
                  {showParentalPin ? 'Masquer' : 'Afficher'} le code
                </button>
              </div>
            )}

            <Button
              type="submit"
              disabled={isLoading || !acceptedTerms || !acceptedPrivacy}
              className="pulse-button-gradient w-full"
            >
              {isLoading ? t('signup.submitting') : showParentalStep ? 'Créer le compte avec protection' : t('signup.submit')}
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
