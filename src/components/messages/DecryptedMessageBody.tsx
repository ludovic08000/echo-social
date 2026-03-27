import { useState, useEffect, memo } from 'react';
import { Lock } from 'lucide-react';
import { VoiceMessagePlayer } from '@/components/chat/VoiceRecorder';

/** Detect voice message pattern: 🎙️ vocal:URL|duration */
function parseVoiceMessage(text: string): { url: string; duration: number } | null {
  const match = text.match(/^🎙️\s*vocal:(.+)\|(\d+)$/);
  if (match) return { url: match[1], duration: parseInt(match[2], 10) };
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

  return <>{displayText}</>;
});
