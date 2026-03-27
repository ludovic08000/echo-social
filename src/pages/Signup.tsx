import { useState, useMemo } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Shield, Phone } from 'lucide-react';
import { differenceInYears } from 'date-fns';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import PasswordStrength from '@/components/PasswordStrength';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';

const MONTHS = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

export default function Signup() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [birthDay, setBirthDay] = useState('');
  const [birthMonth, setBirthMonth] = useState('');
  const [birthYear, setBirthYear] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [showParentalStep, setShowParentalStep] = useState(false);
  const [parentalPin, setParentalPin] = useState('');
  const [parentalPinConfirm, setParentalPinConfirm] = useState('');
  const [showParentalPin, setShowParentalPin] = useState(false);

  const currentYear = new Date().getFullYear();
  const years = useMemo(() => Array.from({ length: currentYear - 1920 + 1 }, (_, i) => currentYear - i), [currentYear]);

  const daysInMonth = useMemo(() => {
    if (!birthMonth || !birthYear) return 31;
    return new Date(Number(birthYear), Number(birthMonth), 0).getDate();
  }, [birthMonth, birthYear]);

  const days = useMemo(() => Array.from({ length: daysInMonth }, (_, i) => i + 1), [daysInMonth]);

  if (user) {
    return <Navigate to="/feed" replace />;
  }

  const getDateOfBirth = (): Date | null => {
    if (!birthDay || !birthMonth || !birthYear) return null;
    return new Date(Number(birthYear), Number(birthMonth) - 1, Number(birthDay));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!lastName.trim() || !firstName.trim()) {
      toast({ title: 'Champs requis', description: 'Le nom et le prénom sont obligatoires.', variant: 'destructive' });
      return;
    }

    const dateOfBirth = getDateOfBirth();
    if (!dateOfBirth) {
      toast({ title: 'Date de naissance requise', description: 'Veuillez indiquer votre date de naissance.', variant: 'destructive' });
      return;
    }

    const today = new Date();
    const age = differenceInYears(today, dateOfBirth);
    const minDate = new Date(today.getFullYear() - 13, today.getMonth(), today.getDate());
    if (dateOfBirth > minDate) {
      toast({ title: 'Âge minimum requis', description: 'Vous devez avoir au moins 13 ans pour vous inscrire.', variant: 'destructive' });
      return;
    }

    const isMinor = age < 16;
    if (isMinor && !showParentalStep) {
      setShowParentalStep(true);
      return;
    }

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

    // Vérification force du mot de passe
    const hasUpper = /[A-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);
    let strength = 0;
    if (password.length >= 6) strength++;
    if (password.length >= 10) strength++;
    if (hasUpper) strength++;
    if (hasNumber) strength++;
    if (hasSpecial) strength++;
    if (strength < 3) {
      toast({
        title: 'Mot de passe trop faible',
        description: 'Votre mot de passe doit contenir au moins 6 caractères, avec des majuscules, des chiffres ou des caractères spéciaux.',
        variant: 'destructive',
      });
      return;
    }

    if (!acceptedTerms || !acceptedPrivacy) {
      toast({ title: 'Conditions requises', description: 'Veuillez accepter les CGU et la politique de confidentialité pour continuer.', variant: 'destructive' });
      return;
    }

    if (password.length < 6) {
      toast({ title: t('signup.passwordTooShort'), description: t('signup.passwordMinLength'), variant: 'destructive' });
      return;
    }

    // Validate phone format if provided
    if (phoneNumber.trim()) {
      let testPhone = phoneNumber.replace(/[\s\-().]/g, '');
      if (testPhone.startsWith('0') && testPhone.length === 10) testPhone = '+33' + testPhone.slice(1);
      if (!testPhone.startsWith('+')) testPhone = '+' + testPhone;
      if (!/^\+[1-9]\d{6,14}$/.test(testPhone)) {
        toast({ title: 'Numéro invalide', description: 'Entrez un numéro valide (ex: +33 6 12 34 56 78)', variant: 'destructive' });
        return;
      }
    }

    // Verify email domain exists (MX check)
    setIsLoading(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const verifyResp = await fetch(`${supabaseUrl}/functions/v1/verify-email-domain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}`, 'apikey': anonKey },
        body: JSON.stringify({ email }),
      });
      const verifyData = await verifyResp.json();
      if (!verifyData.valid) {
        const reasons: Record<string, string> = {
          invalid_format: 'Le format de l\'adresse e-mail est invalide.',
          disposable_email: 'Les adresses e-mail jetables ne sont pas autorisées.',
          no_mx_record: 'Ce domaine e-mail n\'existe pas ou ne peut pas recevoir de mails. Vérifiez l\'orthographe.',
        };
        toast({ title: 'Adresse e-mail invalide', description: reasons[verifyData.reason] || 'Cette adresse e-mail ne semble pas valide.', variant: 'destructive' });
        setIsLoading(false);
        return;
      }
    } catch {
      // Be permissive if check fails
      console.warn('Email domain verification skipped');
    }
    setIsLoading(false);

    // Store signup data in sessionStorage — account will be created after onboarding
    const fullName = `${firstName.trim()} ${lastName.trim()}`;
    const dobString = `${birthYear}-${birthMonth.padStart(2, '0')}-${birthDay.padStart(2, '0')}`;

    const signupData = {
      email,
      password,
      name: fullName,
      dateOfBirth: dobString,
      phoneNumber: phoneNumber.trim(),
      parentalPin: isMinor ? parentalPin : null,
      age,
    };

    sessionStorage.setItem('forsure_signup_pending', JSON.stringify(signupData));
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
                <Input id="lastName" type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Dupont" className="pulse-input" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="firstName">Prénom *</Label>
                <Input id="firstName" type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Jean" className="pulse-input" required />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Date de naissance *</Label>
              <div className="grid grid-cols-3 gap-2">
                <Select value={birthDay} onValueChange={setBirthDay}>
                  <SelectTrigger className="pulse-input">
                    <SelectValue placeholder="Jour" />
                  </SelectTrigger>
                  <SelectContent className="max-h-48">
                    {days.map((d) => (
                      <SelectItem key={d} value={String(d)}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={birthMonth} onValueChange={setBirthMonth}>
                  <SelectTrigger className="pulse-input">
                    <SelectValue placeholder="Mois" />
                  </SelectTrigger>
                  <SelectContent className="max-h-48">
                    {MONTHS.map((m, i) => (
                      <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={birthYear} onValueChange={setBirthYear}>
                  <SelectTrigger className="pulse-input">
                    <SelectValue placeholder="Année" />
                  </SelectTrigger>
                  <SelectContent className="max-h-48">
                    {years.map((y) => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">{t('signup.email')} *</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('signup.emailPlaceholder')} className="pulse-input" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone" className="flex items-center gap-1.5">
                <Phone className="w-3.5 h-3.5" /> Numéro de téléphone
              </Label>
              <Input
                id="phone"
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value.replace(/[^0-9+\s\-()]/g, '').slice(0, 20))}
                placeholder="+33 6 12 34 56 78"
                className="pulse-input"
              />
              <p className="text-[11px] text-muted-foreground">Permet à tes amis de te retrouver via leurs contacts</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{t('signup.password')} *</Label>
              <div className="relative">
                <Input id="password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('signup.passwordPlaceholder')} className="pulse-input pr-10" required minLength={6} />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <PasswordStrength password={password} />
            </div>

            {/* Legal checkboxes */}
            <div className="space-y-3 pt-2">
              <div className="flex items-start gap-3">
                <Checkbox id="terms" checked={acceptedTerms} onCheckedChange={(v) => setAcceptedTerms(v === true)} className="mt-0.5" />
                <label htmlFor="terms" className="text-sm text-muted-foreground leading-tight cursor-pointer">
                  J'ai lu et j'accepte les{' '}
                  <Link to="/legal/terms" className="text-primary hover:underline" target="_blank">Conditions Générales d'Utilisation</Link>
                </label>
              </div>
              <div className="flex items-start gap-3">
                <Checkbox id="privacy" checked={acceptedPrivacy} onCheckedChange={(v) => setAcceptedPrivacy(v === true)} className="mt-0.5" />
                <label htmlFor="privacy" className="text-sm text-muted-foreground leading-tight cursor-pointer">
                  J'ai lu et j'accepte la{' '}
                  <Link to="/legal/privacy" className="text-primary hover:underline" target="_blank">Politique de Confidentialité</Link>
                </label>
              </div>
            </div>

            {/* Parental control step for minors */}
            {showParentalStep && (
              <div className="space-y-3 p-4 rounded-xl bg-destructive/5 border border-destructive/20 animate-fade-in">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Shield className="w-4 h-4 text-destructive" />
                  Protection parentale
                </div>
                <p className="text-xs text-muted-foreground">
                  L'utilisateur a moins de 16 ans. Un parent doit définir un code PIN à 8 chiffres minimum pour le contrôle parental.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Code PIN</Label>
                    <Input type={showParentalPin ? 'text' : 'password'} value={parentalPin} onChange={(e) => setParentalPin(e.target.value.replace(/\D/g, '').slice(0, 12))} placeholder="8 chiffres min." maxLength={12} className="text-center text-lg tracking-[0.3em] font-mono" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Confirmer</Label>
                    <Input type={showParentalPin ? 'text' : 'password'} value={parentalPinConfirm} onChange={(e) => setParentalPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 12))} placeholder="8 chiffres min." maxLength={12} className="text-center text-lg tracking-[0.3em] font-mono" />
                  </div>
                </div>
                <button type="button" onClick={() => setShowParentalPin(!showParentalPin)} className="text-xs text-primary hover:underline">
                  {showParentalPin ? 'Masquer' : 'Afficher'} le code
                </button>
              </div>
            )}

            <Button type="submit" disabled={isLoading || !acceptedTerms || !acceptedPrivacy} className="pulse-button-gradient w-full">
              {isLoading ? t('signup.submitting') : showParentalStep ? 'Continuer avec protection' : 'Continuer'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t('signup.hasAccount')}{' '}
            <Link to="/login" className="pulse-link font-medium">{t('signup.loginLink')}</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
