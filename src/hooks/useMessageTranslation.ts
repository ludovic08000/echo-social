import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { trackAICall } from '@/lib/ml/aiEngine';

/**
 * Simple heuristic to detect if text is likely NOT French.
 * Checks for common French patterns — if few are found, assumes foreign language.
 */
function isLikelyNonFrench(text: string): boolean {
  if (!text || text.trim().length < 15) return false;

  // Skip URLs, emojis-only, system messages
  const clean = text.replace(/https?:\/\/\S+/g, '').replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
  if (clean.length < 10) return false;

  const lower = clean.toLowerCase();

  // Common French words / patterns
  const frenchMarkers = [
    /\b(le|la|les|un|une|des|du|de|au|aux)\b/,
    /\b(je|tu|il|elle|on|nous|vous|ils|elles)\b/,
    /\b(est|sont|suis|es|fait|a|ai|as|avez|ont)\b/,
    /\b(et|ou|mais|donc|car|ni|que|qui|dont|où)\b/,
    /\b(dans|sur|pour|avec|sans|par|chez|entre)\b/,
    /\b(pas|ne|plus|très|bien|aussi|tout|comme)\b/,
    /\b(c'est|j'ai|l'|qu'|n'|d'|s'|m')\b/,
    /\b(bonjour|salut|merci|oui|non|coucou|bonsoir)\b/,
    /[àâäéèêëïîôùûüÿçœæ]/,
  ];

  let hits = 0;
  for (const rx of frenchMarkers) {
    if (rx.test(lower)) hits++;
  }

  // If fewer than 2 French markers detected, likely not French
  return hits < 2;
}

/**
 * Hook for translating message text inline.
 * Auto-detects non-French messages and translates them automatically.
 * Caches translations to avoid re-calling the API.
 */
export function useMessageTranslation() {
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [translating, setTranslating] = useState<string | null>(null);
  const autoTranslatedRef = useRef<Set<string>>(new Set());

  const isEncryptedPayload = useCallback((text: string) => {
    if (!text || !text.startsWith('{')) return false;
    return text.includes('"ct"') || text.includes('"hdr"') || text.includes('"kem"');
  }, []);

  const sanitizeTranslation = useCallback((text: string | null | undefined) => {
    if (!text?.trim()) return null;
    return isEncryptedPayload(text) ? null : text;
  }, [isEncryptedPayload]);

  useEffect(() => {
    setTranslations(prev => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([, value]) => sanitizeTranslation(value) !== null)
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [sanitizeTranslation]);

  const doTranslate = useCallback(async (messageId: string, text: string): Promise<string | null> => {
    if (!text?.trim() || isEncryptedPayload(text)) return null;

    const start = performance.now();
    try {
      const { data, error } = await supabase.functions.invoke('zeus', {
        body: {
          domain: 'content',
          action: 'translate',
          text,
          targetLanguage: 'fr',
        },
      });
      trackAICall('msg-translate', Math.round(performance.now() - start), !error && !data?.error);
      if (error || data?.error) return null;
      return sanitizeTranslation(data?.result || null);
    } catch {
      return null;
    }
  }, [isEncryptedPayload, sanitizeTranslation]);

  const translate = useCallback(async (messageId: string, text: string) => {
    if (!text?.trim() || isEncryptedPayload(text)) return;

    if (translations[messageId]) {
      setTranslations(prev => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      return;
    }

    setTranslating(messageId);
    const result = await doTranslate(messageId, text);
    if (result) {
      setTranslations(prev => ({ ...prev, [messageId]: result }));
    }
    setTranslating(null);
  }, [translations, doTranslate, isEncryptedPayload]);

  const autoTranslateMessages = useCallback((messages: Array<{ id: string; body: string; sender_id: string }>, currentUserId: string | undefined) => {
    if (!currentUserId) return;

    for (const msg of messages) {
      if (msg.sender_id === currentUserId) continue;
      if (translations[msg.id]) continue;
      if (autoTranslatedRef.current.has(msg.id)) continue;
      if (isEncryptedPayload(msg.body)) continue;

      if (isLikelyNonFrench(msg.body)) {
        autoTranslatedRef.current.add(msg.id);
        doTranslate(msg.id, msg.body).then(result => {
          if (result) {
            setTranslations(prev => ({ ...prev, [msg.id]: result }));
          }
        });
      }
    }
  }, [translations, doTranslate, isEncryptedPayload]);

  return { translations, translating, translate, autoTranslateMessages };
}
