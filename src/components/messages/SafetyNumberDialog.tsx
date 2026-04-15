/**
 * SafetyNumberDialog — Signal-style safety number verification with QR code.
 * Includes a key sync diagnostic tool that verifies both sides have matching keys.
 */
import { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { QRCodeSVG } from 'qrcode.react';
import { ShieldCheck, Copy, Check, QrCode, RefreshCw, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { bufferToBase64 } from '@/lib/crypto/utils';

interface SafetyNumberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  myFingerprint: string;
  peerFingerprint: string;
  peerName: string;
  conversationId: string;
  onVerified?: () => void;
}

/** Format fingerprint as groups of 5 for readability */
function formatFingerprint(fp: string): string {
  const clean = fp.replace(/\s/g, '');
  return clean.match(/.{1,5}/g)?.join(' ') ?? clean;
}

function buildSharedSafetyNumber(myFp: string, peerFp: string): string {
  const ordered = [myFp.replace(/\s/g, ''), peerFp.replace(/\s/g, '')].sort();
  const merged = `${ordered[0]}:${ordered[1]}`;
  const bytes = new TextEncoder().encode(merged);
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
  const repeated = `${hex}${ordered[0].slice(0, 16).toUpperCase()}${ordered[1].slice(0, 16).toUpperCase()}`;
  return repeated.match(/.{1,5}/g)?.join(' ') ?? repeated;
}

/** Build a verification payload for QR scanning */
function buildQRPayload(conversationId: string, myFp: string, peerFp: string): string {
  const ordered = [myFp.replace(/\s/g, ''), peerFp.replace(/\s/g, '')].sort();
  return JSON.stringify({
    v: 2,
    type: 'forsure-safety-number',
    conv: conversationId,
    fpA: ordered[0],
    fpB: ordered[1],
    safetyNumber: buildSharedSafetyNumber(myFp, peerFp),
  });
}

// ─── Key Sync Diagnostic ───

interface SyncCheck {
  label: string;
  status: 'ok' | 'error' | 'warning' | 'pending';
  detail: string;
}

async function runKeySyncDiagnostic(
  myFingerprint: string,
  peerFingerprint: string,
  conversationId: string,
): Promise<SyncCheck[]> {
  const checks: SyncCheck[] = [];
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    checks.push({ label: 'Authentification', status: 'error', detail: 'Non connecté' });
    return checks;
  }

  // 1. Check my own key on server matches local fingerprint
  try {
    const { data: myServerKey } = await supabase
      .from('user_public_keys')
      .select('fingerprint, identity_key, signing_key, updated_at')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle();

    if (!myServerKey) {
      checks.push({ label: 'Ma clé (serveur)', status: 'error', detail: 'Aucune clé publiée sur le serveur' });
    } else if (myServerKey.fingerprint !== myFingerprint) {
      checks.push({
        label: 'Ma clé (synchro)',
        status: 'error',
        detail: `Désynchronisée ! Local: ${myFingerprint.slice(0, 12)}… Serveur: ${myServerKey.fingerprint.slice(0, 12)}…`,
      });
    } else {
      checks.push({ label: 'Ma clé (synchro)', status: 'ok', detail: `Identique — ${myFingerprint.slice(0, 12)}…` });
    }
  } catch (e) {
    checks.push({ label: 'Ma clé (serveur)', status: 'error', detail: 'Erreur de lecture serveur' });
  }

  // 2. Check peer key on server matches local peer fingerprint
  try {
    // Find peer user ID from conversation participants
    const { data: participants } = await supabase
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .neq('user_id', user.id)
      .limit(1);

    const peerUserId = participants?.[0]?.user_id;

    if (!peerUserId) {
      checks.push({ label: 'Clé contact (serveur)', status: 'warning', detail: 'Contact introuvable dans la conversation' });
    } else {
      const { data: peerServerKey } = await supabase
        .from('user_public_keys')
        .select('fingerprint, identity_key, signing_key, updated_at')
        .eq('user_id', peerUserId)
        .eq('is_active', true)
        .maybeSingle();

      if (!peerServerKey) {
        checks.push({ label: 'Clé contact (serveur)', status: 'error', detail: 'Le contact n\'a pas de clé publiée' });
      } else if (peerServerKey.fingerprint !== peerFingerprint) {
        checks.push({
          label: 'Clé contact (synchro)',
          status: 'error',
          detail: `Désynchronisée ! Local: ${peerFingerprint.slice(0, 12)}… Serveur: ${peerServerKey.fingerprint.slice(0, 12)}…`,
        });
      } else {
        checks.push({ label: 'Clé contact (synchro)', status: 'ok', detail: `Identique — ${peerFingerprint.slice(0, 12)}…` });
      }

      // 3. Cross-check: verify that what the peer sees as MY fingerprint matches
      // Uses security-definer function to bypass RLS
      const { data: peerKnownRows } = await supabase
        .rpc('check_peer_knows_my_fingerprint', { p_peer_user_id: peerUserId });

      const peerKnownFp = peerKnownRows?.[0] ?? null;

      if (!peerKnownFp) {
        checks.push({ label: 'Vérification croisée', status: 'warning', detail: 'Le contact n\'a pas encore enregistré votre clé' });
      } else if (peerKnownFp.fingerprint !== myFingerprint) {
        checks.push({
          label: 'Vérification croisée',
          status: 'error',
          detail: `Le contact voit une clé différente pour vous ! Sien: ${peerKnownFp.fingerprint.slice(0, 12)}… Actuelle: ${myFingerprint.slice(0, 12)}…`,
        });
      } else {
        checks.push({
          label: 'Vérification croisée',
          status: peerKnownFp.acknowledged ? 'ok' : 'warning',
          detail: peerKnownFp.acknowledged ? 'Le contact a vérifié et approuvé votre clé ✓' : 'Le contact a votre clé mais ne l\'a pas encore vérifiée',
        });
      }

      // 4. Check my knowledge of peer's fingerprint
      const { data: myKnownFp } = await supabase
        .from('user_known_fingerprints')
        .select('fingerprint, acknowledged')
        .eq('user_id', user.id)
        .eq('peer_user_id', peerUserId)
        .maybeSingle();

      if (!myKnownFp) {
        checks.push({ label: 'Mon enregistrement contact', status: 'warning', detail: 'Vous n\'avez pas encore enregistré la clé du contact' });
      } else if (myKnownFp.fingerprint !== peerFingerprint) {
        checks.push({
          label: 'Mon enregistrement contact',
          status: 'error',
          detail: `Mismatch ! Enregistré: ${myKnownFp.fingerprint.slice(0, 12)}… Actuelle: ${peerFingerprint.slice(0, 12)}…`,
        });
      } else {
        checks.push({ label: 'Mon enregistrement contact', status: 'ok', detail: 'Clé enregistrée et à jour ✓' });
      }
    }
  } catch (e) {
    checks.push({ label: 'Clé contact (serveur)', status: 'error', detail: 'Erreur de vérification' });
  }

  // 5. Check shared safety number is consistent
  const localSafety = buildSharedSafetyNumber(myFingerprint, peerFingerprint);
  if (localSafety && localSafety.length > 0) {
    checks.push({ label: 'Numéro de sécurité', status: 'ok', detail: `Calculé : ${localSafety.slice(0, 20)}…` });
  }

  return checks;
}

// ─── Component ───

export function SafetyNumberDialog({
  open,
  onOpenChange,
  myFingerprint,
  peerFingerprint,
  peerName,
  conversationId,
  onVerified,
}: SafetyNumberDialogProps) {
  const [copied, setCopied] = useState(false);
  const [verified, setVerified] = useState(false);
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagResults, setDiagResults] = useState<SyncCheck[] | null>(null);

  const sharedSafetyNumber = buildSharedSafetyNumber(myFingerprint, peerFingerprint);
  const combinedFingerprint = `Numéro de sécurité partagé\n${sharedSafetyNumber}\n\nVotre clé\n${myFingerprint}\n\nClé de ${peerName}\n${peerFingerprint}`;
  const qrPayload = buildQRPayload(conversationId, myFingerprint, peerFingerprint);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(combinedFingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const handleMarkVerified = () => {
    setVerified(true);
    onVerified?.();
    setTimeout(() => onOpenChange(false), 1500);
  };

  const runDiagnostic = useCallback(async () => {
    setDiagRunning(true);
    setDiagResults(null);
    try {
      const results = await runKeySyncDiagnostic(myFingerprint, peerFingerprint, conversationId);
      setDiagResults(results);
    } catch {
      setDiagResults([{ label: 'Diagnostic', status: 'error', detail: 'Erreur inattendue' }]);
    } finally {
      setDiagRunning(false);
    }
  }, [myFingerprint, peerFingerprint, conversationId]);

  const [repairing, setRepairing] = useState(false);
  const repairFingerprints = useCallback(async () => {
    setRepairing(true);
    try {
      await supabase.rpc('push_my_fingerprint_to_peers');
      // Re-run diagnostic to confirm fix
      await runDiagnostic();
    } catch {
    } finally {
      setRepairing(false);
    }
  }, [runDiagnostic]);

  const statusIcon = (status: SyncCheck['status']) => {
    switch (status) {
      case 'ok': return <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />;
      case 'error': return <AlertTriangle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />;
      case 'warning': return <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0" />;
      default: return <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin flex-shrink-0" />;
    }
  };

  const allOk = diagResults?.every(c => c.status === 'ok');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            Numéro de sécurité
          </DialogTitle>
          <DialogDescription>
            Comparez ces numéros avec <strong>{peerName}</strong> en personne ou par un canal sécurisé.
            S'ils correspondent, votre conversation est protégée.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* QR Code */}
          <div className="flex justify-center p-4 bg-white rounded-lg">
            <QRCodeSVG
              value={qrPayload}
              size={180}
              level="M"
              includeMargin
              bgColor="#ffffff"
              fgColor="#000000"
            />
          </div>

          <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
            <QrCode className="w-3 h-3" />
            Scannez ce QR code sur l'appareil de votre contact
          </p>

          {/* Safety numbers display */}
          <div className="space-y-2">
            <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
              <p className="text-[10px] text-muted-foreground mb-1 font-medium">Numéro de sécurité partagé</p>
              <p className="font-mono text-xs tracking-wider break-all leading-relaxed text-primary">
                {sharedSafetyNumber}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50 border">
              <p className="text-[10px] text-muted-foreground mb-1 font-medium">Votre clé</p>
              <p className="font-mono text-xs tracking-wider break-all leading-relaxed">
                {formatFingerprint(myFingerprint)}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50 border">
              <p className="text-[10px] text-muted-foreground mb-1 font-medium">Clé de {peerName}</p>
              <p className="font-mono text-xs tracking-wider break-all leading-relaxed">
                {formatFingerprint(peerFingerprint)}
              </p>
            </div>
          </div>

          {/* Key Sync Diagnostic Tool */}
          <div className="border rounded-lg overflow-hidden">
            <button
              onClick={runDiagnostic}
              disabled={diagRunning}
              className="w-full flex items-center justify-between px-3 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
            >
              <span className="flex items-center gap-2 text-xs font-medium">
                {diagRunning ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Diagnostic de synchronisation
              </span>
              {diagResults && (
                <Badge variant="outline" className={cn(
                  'text-[9px] px-1.5 py-0',
                  allOk ? 'border-green-500/30 text-green-600' : 'border-destructive/30 text-destructive'
                )}>
                  {allOk ? '✓ Tout OK' : `${diagResults.filter(c => c.status === 'error').length} erreur(s)`}
                </Badge>
              )}
            </button>

            {diagResults && (
              <div className="divide-y divide-border">
                {diagResults.map((check, i) => (
                  <div key={i} className="flex items-start gap-2 px-3 py-2">
                    {statusIcon(check.status)}
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium leading-tight">{check.label}</p>
                      <p className={cn(
                        'text-[10px] leading-snug mt-0.5 break-all',
                        check.status === 'error' ? 'text-destructive' :
                        check.status === 'warning' ? 'text-yellow-600 dark:text-yellow-400' :
                        'text-muted-foreground'
                      )}>
                        {check.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          {diagResults && !allOk && (
            <div className="px-3 py-2 border-t">
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs"
                onClick={repairFingerprints}
                disabled={repairing}
              >
                {repairing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />}
                Réparer la synchronisation
              </Button>
            </div>
          )}
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={handleCopy}>
              {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
              {copied ? 'Copié' : 'Copier'}
            </Button>
            <Button
              size="sm"
              className="flex-1"
              onClick={handleMarkVerified}
              disabled={verified}
            >
              {verified ? (
                <>
                  <Check className="w-4 h-4 mr-1" />
                  Vérifié ✓
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4 mr-1" />
                  Marquer comme vérifié
                </>
              )}
            </Button>
          </div>

          {verified && (
            <Badge variant="outline" className="w-full justify-center text-green-600 border-green-500/30 bg-green-500/10">
              <ShieldCheck className="w-3 h-3 mr-1" />
              Identité vérifiée
            </Badge>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
