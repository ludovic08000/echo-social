/**
 * SafetyNumberDialog — Signal-style safety number verification with QR code.
 * Users scan each other's QR codes in person to confirm E2EE identity keys.
 */
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { QRCodeSVG } from 'qrcode.react';
import { ShieldCheck, Copy, Check, QrCode, ScanLine } from 'lucide-react';
import { cn } from '@/lib/utils';

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

function toHexBytes(input: string): Uint8Array {
  const clean = input.replace(/\s/g, '').toLowerCase();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-500" />
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
            <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
              <p className="text-[10px] text-muted-foreground mb-1 font-medium">Numéro de sécurité partagé</p>
              <p className="font-mono text-xs tracking-wider break-all leading-relaxed text-emerald-700 dark:text-emerald-400">
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
            <Badge variant="outline" className="w-full justify-center text-emerald-600 border-emerald-500/30 bg-emerald-500/10">
              <ShieldCheck className="w-3 h-3 mr-1" />
              Identité vérifiée
            </Badge>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
