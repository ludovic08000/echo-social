import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { ShieldCheck, ShieldX, Loader2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

export default function SecurityDeviceVerify() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token');
  const initialAction = params.get('action') as 'approve' | 'reject' | null;
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);

  const submit = async (d: 'approve' | 'reject') => {
    if (!token) return;
    setStatus('loading');
    setDecision(d);
    const { data, error } = await supabase.functions.invoke('device-security', {
      body: { action: 'verify', token, decision: d },
    });
    if (error || !data?.ok) {
      setStatus('error');
      toast({ title: 'Erreur', description: 'Lien invalide ou expiré', variant: 'destructive' });
      return;
    }
    setStatus('done');
    if (d === 'reject') {
      toast({ title: 'Appareil révoqué', description: 'Pensez à changer votre mot de passe immédiatement.' });
    } else {
      toast({ title: 'Appareil approuvé', description: 'Cet appareil est désormais de confiance.' });
    }
  };

  useEffect(() => {
    if (initialAction && token && status === 'idle') {
      void submit(initialAction);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAction, token]);

  if (!token) {
    return (
      <AppLayout fullWidth>
        <div className="max-w-md mx-auto p-8 text-center">
          <p className="text-muted-foreground">Lien invalide.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout fullWidth>
      <div className="max-w-md mx-auto p-6 sm:p-10">
        <div className="bg-card/50 backdrop-blur-xl border border-border/40 rounded-3xl p-8 shadow-xl">
          {status === 'loading' && (
            <div className="flex flex-col items-center gap-4 py-8">
              <Loader2 className="w-10 h-10 text-primary animate-spin" />
              <p className="text-sm text-muted-foreground">Validation en cours…</p>
            </div>
          )}

          {status === 'done' && decision === 'approve' && (
            <div className="text-center space-y-4 py-4">
              <div className="w-16 h-16 rounded-full bg-primary/15 mx-auto flex items-center justify-center">
                <ShieldCheck className="w-8 h-8 text-primary" />
              </div>
              <h1 className="text-xl font-bold" style={{ fontFamily: 'Playfair Display, serif' }}>Appareil approuvé</h1>
              <p className="text-sm text-muted-foreground">Cet appareil est désormais reconnu comme appareil de confiance.</p>
              <Button onClick={() => navigate('/settings')} className="rounded-full">Voir mes appareils</Button>
            </div>
          )}

          {status === 'done' && decision === 'reject' && (
            <div className="text-center space-y-4 py-4">
              <div className="w-16 h-16 rounded-full bg-destructive/15 mx-auto flex items-center justify-center">
                <ShieldX className="w-8 h-8 text-destructive" />
              </div>
              <h1 className="text-xl font-bold" style={{ fontFamily: 'Playfair Display, serif' }}>Appareil révoqué</h1>
              <p className="text-sm text-muted-foreground">
                Voulez-vous changer votre mot de passe maintenant ? C'est fortement recommandé.
              </p>
              <div className="flex flex-col gap-2 pt-2">
                <Button onClick={() => navigate('/forgot-password')} variant="destructive" className="rounded-full">
                  Changer mon mot de passe
                </Button>
                <Button onClick={() => navigate('/settings')} variant="ghost" className="rounded-full">Plus tard</Button>
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="text-center space-y-3 py-4">
              <ShieldX className="w-10 h-10 text-destructive mx-auto" />
              <p className="text-sm text-muted-foreground">Lien invalide ou déjà utilisé.</p>
              <Button onClick={() => navigate('/settings')} variant="outline" className="rounded-full">Retour</Button>
            </div>
          )}

          {status === 'idle' && (
            <div className="space-y-4 text-center">
              <h1 className="text-xl font-bold" style={{ fontFamily: 'Playfair Display, serif' }}>Confirmer cet appareil</h1>
              <p className="text-sm text-muted-foreground">
                Une connexion a été détectée depuis un nouvel appareil. Confirmez si c'est bien vous.
              </p>
              <div className="flex flex-col gap-2 pt-2">
                <Button onClick={() => submit('approve')} className="rounded-full bg-primary">✓ C'est bien moi</Button>
                <Button onClick={() => submit('reject')} variant="destructive" className="rounded-full">⚠ Ce n'est pas moi</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
