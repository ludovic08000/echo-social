import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { trackAICall } from '@/lib/aiEngine';
import { toast } from 'sonner';

/**
 * Hook for translating message text inline.
 * Caches translations to avoid re-calling the API.
 */
export function useMessageTranslation() {
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [translating, setTranslating] = useState<string | null>(null);

  const translate = useCallback(async (messageId: string, text: string) => {
    if (translations[messageId]) {
      // Toggle off
      setTranslations(prev => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      return;
    }

    setTranslating(messageId);
    const start = performance.now();
    try {
      const { data, error } = await supabase.functions.invoke('zeus', {
        body: {
          domain: 'content',
          action: 'translate',
          text,
          targetLanguage: navigator.language?.startsWith('fr') ? 'fr' : 'en',
        },
      });
      trackAICall('msg-translate', Math.round(performance.now() - start), !error && !data?.error);
      if (error || data?.error) {
        toast.error('Erreur de traduction');
        return;
      }
      if (data?.result) {
        setTranslations(prev => ({ ...prev, [messageId]: data.result }));
      }
    } catch {
      toast.error('Erreur de traduction');
    } finally {
      setTranslating(null);
    }
  }, [translations]);

  return { translations, translating, translate };
}
