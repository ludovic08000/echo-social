import { useState, useEffect, memo } from 'react';
import { Lock } from 'lucide-react';

interface DecryptedMessageBodyProps {
  body: string;
  decrypt: (body: string) => Promise<{ text: string; encrypted: boolean; verified: boolean }>;
  isEncryptionActive: boolean;
  /** Callback when decryption succeeds — used to cache plaintext for actions */
  onDecrypted?: (text: string) => void;
}

/**
 * Component that handles async decryption of E2EE messages.
 * Shows a lock icon while decrypting, then displays the plaintext.
 * Falls back to raw body if decryption fails.
 */
export const DecryptedMessageBody = memo(function DecryptedMessageBody({
  body,
  decrypt,
  isEncryptionActive,
  onDecrypted,
}: DecryptedMessageBodyProps) {
  const [displayText, setDisplayText] = useState<string | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);

  useEffect(() => {
    if (!isEncryptionActive) {
      setDisplayText(body);
      return;
    }

    // Check if body looks like an encrypted envelope
    const looksEncrypted = body.startsWith('{') && (body.includes('"ct"') || body.includes('"hdr"'));
    if (!looksEncrypted) {
      // SECURITY: In encrypted conversations, non-encrypted messages should be flagged
      // Allow known system messages (emoji, photo markers, etc.) through
      const isSystemMsg = body === '📷 Photo' || body.startsWith('🎙️ voice:') || body.startsWith('↩️');
      if (isSystemMsg) {
        setDisplayText(body);
      } else {
        // Never display raw unencrypted text in an encrypted conversation
        setDisplayText('⚠️ Message non chiffré');
      }
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

  return <>{displayText}</>;
});
