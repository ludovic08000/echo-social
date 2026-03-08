import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { useIsMinorWithParentalControl, useVerifyParentalPin } from '@/hooks/useParentalControl';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Shield, Lock } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface ParentalContextType {
  isMinor: boolean;
  allowedCategories: string[];
  isUnlocked: boolean;
  requestUnlock: (onSuccess?: () => void) => void;
  isCategoryAllowed: (category?: string | null) => boolean;
}

const ParentalContext = createContext<ParentalContextType>({
  isMinor: false,
  allowedCategories: [],
  isUnlocked: false,
  requestUnlock: () => {},
  isCategoryAllowed: () => true,
});

export function useParentalGate() {
  return useContext(ParentalContext);
}

export function ParentalGateProvider({ children }: { children: ReactNode }) {
  const { isMinor, allowedCategories, isLoading } = useIsMinorWithParentalControl();
  const verifyPin = useVerifyParentalPin();
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [pin, setPin] = useState('');
  const [onSuccessCallback, setOnSuccessCallback] = useState<(() => void) | null>(null);

  const requestUnlock = useCallback((onSuccess?: () => void) => {
    if (isUnlocked) {
      onSuccess?.();
      return;
    }
    setOnSuccessCallback(() => onSuccess || null);
    setShowDialog(true);
    setPin('');
  }, [isUnlocked]);

  const handleVerify = async () => {
    if (pin.length !== 4) return;
    const valid = await verifyPin.mutateAsync(pin);
    if (valid) {
      setIsUnlocked(true);
      setShowDialog(false);
      toast({ title: '🔓 Accès déverrouillé', description: 'Session parentale active' });
      onSuccessCallback?.();
    } else {
      toast({ title: 'Code incorrect', variant: 'destructive' });
      setPin('');
    }
  };

  const isCategoryAllowed = useCallback((category?: string | null) => {
    if (!isMinor || isUnlocked) return true;
    if (!category) return false; // No category = potentially sensitive
    return allowedCategories.includes(category.toLowerCase());
  }, [isMinor, isUnlocked, allowedCategories]);

  return (
    <ParentalContext.Provider value={{ isMinor, allowedCategories, isUnlocked, requestUnlock, isCategoryAllowed }}>
      {children}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="w-5 h-5 text-pink-500" />
              Code parental requis
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Ce contenu est protégé par le contrôle parental. Entrez le code PIN pour y accéder.
          </p>
          <Input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="• • • •"
            maxLength={4}
            className="text-center text-xl tracking-[0.5em] font-mono"
            onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
            autoFocus
          />
          <Button onClick={handleVerify} disabled={pin.length !== 4 || verifyPin.isPending} className="w-full">
            <Shield className="w-4 h-4 mr-2" />
            {verifyPin.isPending ? 'Vérification...' : 'Déverrouiller'}
          </Button>
        </DialogContent>
      </Dialog>
    </ParentalContext.Provider>
  );
}
