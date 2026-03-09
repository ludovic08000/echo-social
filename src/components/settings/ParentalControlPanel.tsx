import { useState } from 'react';
import { Shield, Lock, Check, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/hooks/use-toast';
import { useParentalControl, useSetParentalPin, useVerifyParentalPin, CATEGORY_LABELS, ALLOWED_MINOR_CATEGORIES, PIN_MIN_LENGTH, PIN_MAX_LENGTH } from '@/hooks/useParentalControl';

export function ParentalControlPanel() {
  const { data: parentalControl, isLoading } = useParentalControl();
  const setPin = useSetParentalPin();
  const verifyPin = useVerifyParentalPin();

  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [unlocked, setUnlocked] = useState(!parentalControl);
  const [categories, setCategories] = useState<string[]>(
    parentalControl?.allowed_categories || [...ALLOWED_MINOR_CATEGORIES]
  );

  const hasExistingPin = !!parentalControl;

  const handleUnlock = async () => {
    if (!currentPin || currentPin.length < PIN_MIN_LENGTH) {
      toast({ title: 'Code invalide', description: `Entrez le code PIN à ${PIN_MIN_LENGTH} chiffres minimum`, variant: 'destructive' });
      return;
    }
    try {
      const valid = await verifyPin.mutateAsync(currentPin);
      if (valid) {
        setUnlocked(true);
        setCategories(parentalControl?.allowed_categories || [...ALLOWED_MINOR_CATEGORIES]);
        toast({ title: '🔓 Déverrouillé' });
      } else {
        toast({ title: 'Code incorrect', variant: 'destructive' });
      }
    } catch (err: any) {
      const msg = err?.message?.includes('429') ? 'Trop de tentatives. Réessayez dans 5 minutes.' : 'Erreur de vérification';
      toast({ title: msg, variant: 'destructive' });
    }
  };

  const handleSave = async () => {
    if (newPin.length < PIN_MIN_LENGTH || !/^\d+$/.test(newPin)) {
      toast({ title: 'Code invalide', description: `Le code doit être composé de ${PIN_MIN_LENGTH} chiffres minimum`, variant: 'destructive' });
      return;
    }
    if (newPin !== confirmPin) {
      toast({ title: 'Les codes ne correspondent pas', variant: 'destructive' });
      return;
    }
    if (categories.length === 0) {
      toast({ title: 'Sélectionnez au moins une catégorie', variant: 'destructive' });
      return;
    }

    await setPin.mutateAsync({ pin: newPin, allowedCategories: categories });
    toast({ title: '✅ Contrôle parental activé', description: 'Le code PIN et les catégories ont été enregistrés.' });
    setNewPin('');
    setConfirmPin('');
    setCurrentPin('');
  };

  const toggleCategory = (cat: string) => {
    setCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  if (isLoading) return <div className="text-sm text-muted-foreground">Chargement...</div>;

  // If parental control exists and not unlocked, show PIN entry
  if (hasExistingPin && !unlocked) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <Lock className="w-5 h-5 text-amber-500 shrink-0" />
          <p className="text-sm text-foreground">
            Le contrôle parental est <span className="font-semibold text-amber-600">actif</span>. Entrez le code PIN pour modifier les paramètres.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Code PIN parental</Label>
          <div className="flex gap-2">
             <Input
              type={showPin ? 'text' : 'password'}
              value={currentPin}
              onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, PIN_MAX_LENGTH))}
              placeholder="• • • • • • • •"
              maxLength={PIN_MAX_LENGTH}
              className="text-center text-lg tracking-[0.3em] font-mono max-w-[240px]"
            />
            <Button variant="ghost" size="icon" onClick={() => setShowPin(!showPin)}>
              {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
            <Button onClick={handleUnlock} disabled={currentPin.length < PIN_MIN_LENGTH}>
              Déverrouiller
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 p-4 rounded-xl bg-primary/5 border border-primary/10">
        <Shield className="w-5 h-5 text-primary shrink-0" />
        <p className="text-sm text-muted-foreground">
          Définissez un code PIN à 8 chiffres minimum pour protéger l'accès aux contenus sensibles. Les mineurs ne verront que les catégories autorisées.
        </p>
        </p>
      </div>

      {/* PIN setup */}
      <div className="space-y-3">
        <Label className="text-sm font-semibold">{hasExistingPin ? 'Changer le code PIN' : 'Définir un code PIN'}</Label>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Nouveau code</Label>
            <Input
              type={showPin ? 'text' : 'password'}
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="• • • •"
              maxLength={4}
              className="text-center text-lg tracking-[0.5em] font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Confirmer</Label>
            <Input
              type={showPin ? 'text' : 'password'}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="• • • •"
              maxLength={4}
              className="text-center text-lg tracking-[0.5em] font-mono"
            />
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowPin(!showPin)} className="text-xs">
          {showPin ? <EyeOff className="w-3 h-3 mr-1" /> : <Eye className="w-3 h-3 mr-1" />}
          {showPin ? 'Masquer' : 'Afficher'} le code
        </Button>
      </div>

      {/* Category selection */}
      <div className="space-y-3">
        <Label className="text-sm font-semibold">Catégories autorisées pour le mineur</Label>
        <p className="text-xs text-muted-foreground">Seuls les contenus de ces catégories seront visibles. Le reste nécessitera le code PIN.</p>
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
            <label
              key={key}
              className={`flex items-center gap-2.5 p-3 rounded-xl border cursor-pointer transition-all ${
                categories.includes(key)
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border/40 hover:border-border'
              }`}
            >
              <Checkbox
                checked={categories.includes(key)}
                onCheckedChange={() => toggleCategory(key)}
              />
              <span className="text-sm">{label}</span>
            </label>
          ))}
        </div>
      </div>

      <Button
        onClick={handleSave}
        disabled={newPin.length !== 4 || setPin.isPending}
        className="w-full"
      >
        {setPin.isPending ? 'Enregistrement...' : (
          <>
            <Check className="w-4 h-4 mr-2" />
            {hasExistingPin ? 'Mettre à jour' : 'Activer le contrôle parental'}
          </>
        )}
      </Button>
    </div>
  );
}
