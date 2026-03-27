import { useState, useEffect, memo } from 'react';
import { Lock } from 'lucide-react';
import { VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';

/** Detect voice message pattern — supports multiple formats:
 *  🎙️ vocal:URL|duration
 *  🎙️ voice:URL|dur:duration
 *  🎙️ voice:URL|duration
 */
function parseVoiceMessage(text: string): { url: string; duration: number } | null {
  // Format: 🎙️ vocal:URL|123  or  🎙️ voice:URL|123
  const m1 = text.match(/^🎙️\s*(?:vocal|voice):(.+)\|(\d+)$/);
  if (m1) return { url: m1[1], duration: parseInt(m1[2], 10) };
  // Format: 🎙️ voice:URL|dur:123
  const m2 = text.match(/^🎙️\s*(?:vocal|voice):(.+)\|dur:(\d+)$/);
  if (m2) return { url: m2[1], duration: parseInt(m2[2], 10) };
  return null;
}

/** Detect GIF message pattern: GIF:URL */
function parseGifMessage(text: string): string | null {
  const match = text.match(/^GIF:(https?:\/\/.+)$/i);
  if (match) return match[1];
  return null;
}

interface DecryptedMessageBodyProps {
  body: string;
  decrypt: (body: string) => Promise<{ text: string; encrypted: boolean; verified: boolean }>;
  isEncryptionActive: boolean;
  onDecrypted?: (text: string) => void;
  isMe?: boolean;
}

export const DecryptedMessageBody = memo(function DecryptedMessageBody({
  body,
  decrypt,
  isEncryptionActive,
  onDecrypted,
  isMe,
}: DecryptedMessageBodyProps) {
  const [displayText, setDisplayText] = useState<string | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);

  useEffect(() => {
    if (!isEncryptionActive) {
      setDisplayText(body);
      return;
    }

    const looksEncrypted = body.startsWith('{') && (body.includes('"ct"') || body.includes('"hdr"'));
    if (!looksEncrypted) {
      setDisplayText(body);
      return;
    }

    let cancelled = false;
    setIsDecrypting(true);

    decrypt(body).then(result => {
      if (!cancelled) {
        setDisplayText(result.text);
        setIsDecrypting(false);
        onDecrypted?.(result.text);
      }
    }).catch(() => {
      if (!cancelled) {
        setDisplayText('🔒 Message chiffré');
        setIsDecrypting(false);
      }
    });

    return () => { cancelled = true; };
  }, [body, decrypt, isEncryptionActive, onDecrypted]);

  if (isDecrypting || displayText === null) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Lock className="w-3 h-3 animate-pulse" />
        <span className="text-xs">Déchiffrement...</span>
      </span>
    );
  }

  // Check if it's a voice message
  const voice = parseVoiceMessage(displayText);
  if (voice) {
    return <VoiceMessagePlayer audioUrl={voice.url} duration={voice.duration} isMe={isMe} />;
  }

  // Check if it's a GIF message
  const gifUrl = parseGifMessage(displayText);
  if (gifUrl) {
    return (
      <img
        src={gifUrl}
        alt="GIF"
        className="rounded-lg max-w-[220px] max-h-[200px] object-contain"
        loading="lazy"
      />
    );
  }

  return <>{displayText}</>;
});
