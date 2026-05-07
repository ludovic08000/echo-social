import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { KeyRound, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { rotateOwnerSession, ensureOwnerSession, snapshotForDistribution } from '@/lib/crypto/senderKeySession';
import { invalidateSenderKeysFlag } from '@/lib/crypto/senderKeyOutbound';
import { getOrCreateCurrentDeviceId } from '@/lib/crypto/deviceList';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  conversationId: string;
  isGroup: boolean;
}

/**
 * Opt-in toggle for Sender Keys (group E2EE chain).
 * - Enable: server flips `conversations.enable_sender_keys`. Next send will
 *   create the chain & fan out an SKDM via the legacy pairwise ratchet.
 * - Rotate: regenerates the chain immediately (forward secrecy on member
 *   change or perceived compromise). A new SKDM will be sent on next message.
 *
 * Pure UI wiring — encryption/transport remain in `senderKeySession.ts`.
 */
export function SenderKeysDialog({ open, onOpenChange, conversationId, isGroup }: Props) {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from('conversations')
        .select('enable_sender_keys')
        .eq('id', conversationId)
        .maybeSingle();
      setEnabled(!!(data as any)?.enable_sender_keys);
      setLoading(false);
    })();
  }, [open, conversationId]);

  const persist = async (next: boolean) => {
    setSaving(true);
    const { error } = await supabase
      .from('conversations')
      .update({ enable_sender_keys: next } as any)
      .eq('id', conversationId);
    setSaving(false);
    if (error) {
      toast.error("Échec de la mise à jour");
      return;
    }
    setEnabled(next);
    invalidateSenderKeysFlag(conversationId);
    toast.success(next ? 'Sender Keys activé' : 'Sender Keys désactivé');
  };

  const rotate = async () => {
    if (!user) return;
    setRotating(true);
    try {
      const did = getOrCreateCurrentDeviceId();
      await ensureOwnerSession(conversationId, user.id, did);
      const next = await rotateOwnerSession(conversationId, user.id, did);
      // SKDM will be fanned out by send pipeline on next message; pre-build
      // to surface any error early.
      snapshotForDistribution(next);
      invalidateSenderKeysFlag(conversationId);
      toast.success('Chaîne régénérée — un nouveau SKDM sera envoyé au prochain message.');
    } catch (e: any) {
      toast.error(`Rotation impossible : ${e?.message ?? 'erreur'}`);
    } finally {
      setRotating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="w-5 h-5" />
            Chiffrement de groupe (Sender Keys)
          </DialogTitle>
          <DialogDescription>
            Active une chaîne de clés dédiée au groupe (style Signal/WhatsApp).
            Réduit la charge crypto sur les grands groupes tout en conservant
            l'E2EE bout-en-bout. La distribution initiale (SKDM) passe par les
            sessions pairwise existantes.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5 py-2">
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/50 bg-card/40 px-4 py-3">
              <div className="space-y-0.5">
                <Label htmlFor="sk-toggle" className="text-sm font-semibold">
                  Activer Sender Keys
                </Label>
                <p className="text-xs text-muted-foreground">
                  {isGroup
                    ? 'Recommandé pour les groupes de 3+ membres.'
                    : 'Disponible aussi en 1:1 (peu d\'intérêt face au pairwise).'}
                </p>
              </div>
              <Switch
                id="sk-toggle"
                checked={enabled}
                disabled={saving}
                onCheckedChange={persist}
              />
            </div>

            <div className="flex items-start gap-3 rounded-2xl border border-border/50 bg-card/40 px-4 py-3">
              <ShieldCheck className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Régénère immédiatement la chaîne (forward secrecy) — à faire
                  après un changement de membre ou un soupçon de compromission.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={rotate}
                  disabled={!enabled || rotating}
                  className="rounded-full"
                >
                  {rotating ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <RefreshCw className="w-4 h-4 mr-2" />
                  )}
                  Régénérer la chaîne
                </Button>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
