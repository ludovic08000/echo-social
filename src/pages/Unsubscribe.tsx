import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { MailX, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

export default function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [status, setStatus] = useState<'loading' | 'valid' | 'used' | 'invalid' | 'done' | 'error'>('loading');
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (!token) { setStatus('invalid'); return; }
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/handle-email-unsubscribe?token=${token}`;
    fetch(url, { headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY } })
      .then(r => r.json())
      .then(d => {
        if (d.valid === false && d.reason === 'already_unsubscribed') setStatus('used');
        else if (d.valid) setStatus('valid');
        else setStatus('invalid');
      })
      .catch(() => setStatus('error'));
  }, [token]);

  const handleConfirm = async () => {
    setProcessing(true);
    try {
      const { data } = await supabase.functions.invoke('handle-email-unsubscribe', { body: { token } });
      if (data?.success) setStatus('done');
      else if (data?.reason === 'already_unsubscribed') setStatus('used');
      else setStatus('error');
    } catch { setStatus('error'); }
    setProcessing(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full text-center space-y-6">
        {status === 'loading' && <Loader2 className="w-10 h-10 mx-auto text-primary animate-spin" />}
        {status === 'valid' && (
          <>
            <MailX className="w-16 h-16 mx-auto text-muted-foreground" />
            <h1 className="text-2xl font-bold text-foreground">Se désabonner</h1>
            <p className="text-muted-foreground">Vous ne recevrez plus d'emails de notification de Forsure.</p>
            <Button onClick={handleConfirm} disabled={processing} size="lg" className="w-full">
              {processing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Confirmer le désabonnement
            </Button>
          </>
        )}
        {status === 'done' && (
          <>
            <CheckCircle className="w-16 h-16 mx-auto text-green-500" />
            <h1 className="text-2xl font-bold text-foreground">Désabonné</h1>
            <p className="text-muted-foreground">Vous avez été désabonné avec succès.</p>
          </>
        )}
        {status === 'used' && (
          <>
            <CheckCircle className="w-16 h-16 mx-auto text-muted-foreground" />
            <h1 className="text-2xl font-bold text-foreground">Déjà désabonné</h1>
            <p className="text-muted-foreground">Vous êtes déjà désabonné de ces notifications.</p>
          </>
        )}
        {(status === 'invalid' || status === 'error') && (
          <>
            <AlertCircle className="w-16 h-16 mx-auto text-destructive" />
            <h1 className="text-2xl font-bold text-foreground">Lien invalide</h1>
            <p className="text-muted-foreground">Ce lien de désabonnement est invalide ou a expiré.</p>
          </>
        )}
      </div>
    </div>
  );
}
