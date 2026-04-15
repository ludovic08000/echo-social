import { useState, useEffect, memo } from 'react';
import { Lock } from 'lucide-react';
import { VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';
import { hasMediaKey, parseMediaMessage } from '@/lib/crypto/mediaEncrypt';

function looksEncryptedMessage(body: string): boolean {
  return body.startsWith('{') && body.includes('"ct"');
}

/** Detect voice message pattern — supports multiple formats:
 *  🎙️ vocal:URL|duration
 *  🎙️ voice:URL|dur:duration
 *  🎙️ voice:URL|duration
 */
function parseVoiceMessage(text: string): { url: string; duration: number } | null {
  const m1 = text.match(/^🎙️\s*(?:vocal|voice):(.+)\|(\d+)$/);
  if (m1) return { url: m1[1], duration: parseInt(m1[2], 10) };
  const m2 = text.match(/^🎙️\s*(?:vocal|voice):(.+)\|dur:(\d+)$/);
  if (m2) return { url: m2[1], duration: parseInt(m2[2], 10) };
  return null;
}

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
  const [mediaKeyB64, setMediaKeyB64] = useState<string | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);

  useEffect(() => {
    const shouldAttemptDecrypt = isEncryptionActive || looksEncryptedMessage(body);

    if (!shouldAttemptDecrypt) {
      setDisplayText(body);
      setMediaKeyB64(null);
      return;
    }

    if (!looksEncryptedMessage(body)) {
      setDisplayText(body);
      setMediaKeyB64(null);
      return;
    }

    let cancelled = false;
    setIsDecrypting(true);

    decrypt(body).then(result => {
      if (!cancelled) {
        if (hasMediaKey(result.text)) {
          const parsed = parseMediaMessage(result.text);
          if (parsed) {
            setMediaKeyB64(parsed.keyB64);
            setDisplayText(parsed.label);
          } else {
            setDisplayText(result.text);
            setMediaKeyB64(null);
          }
        } else {
          setDisplayText(result.text);
          setMediaKeyB64(null);
        }
        setIsDecrypting(false);
        onDecrypted?.(result.text);
      }
    }).catch(() => {
      if (!cancelled) {
        setDisplayText('🔒 Message chiffré');
        setMediaKeyB64(null);
        setIsDecrypting(false);
      }
    });

    return () => { cancelled = true; };
  }, [body, decrypt, isEncryptionActive, onDecrypted, isMe]);

  if (isDecrypting || displayText === null) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Lock className="w-3 h-3 animate-pulse" />
        <span className="text-xs">Déchiffrement...</span>
      </span>
    );
  }

  const voice = parseVoiceMessage(displayText);
  if (voice) {
    return (
      <VoiceMessagePlayer
        audioUrl={voice.url}
        duration={voice.duration}
        isMe={isMe}
        mediaKeyB64={mediaKeyB64 ?? undefined}
      />
    );
  }

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
