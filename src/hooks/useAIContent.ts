import { useState, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { trackAICall } from '@/lib/aiEngine';
import { loadContentPrefs } from '@/lib/feedAlgorithm';
import { CONTENT_PREFS_CHANGED_EVENT } from '@/lib/feedPreferences';

function getLanguage(): string {
  return localStorage.getItem('app-locale') || 'fr';
}

export function useAIContent() {
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [translateLoading, setTranslateLoading] = useState(false);
  const [prefs, setPrefs] = useState(loadContentPrefs);

  useEffect(() => {
    const refresh = () => setPrefs(loadContentPrefs());
    window.addEventListener(CONTENT_PREFS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CONTENT_PREFS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const summarize = useCallback(async (text: string): Promise<string | null> => {
    if (!text || text.length < 100) return null;
    setSummaryLoading(true);
    const start = performance.now();
    try {
      const { data, error } = await supabase.functions.invoke('zeus', {
        body: { domain: 'content', action: 'summarize', text },
      });
      trackAICall('content-summarizer', Math.round(performance.now() - start), !error && !data?.error);
      if (error) throw error;
      if (data?.error) {
        toast({ title: 'IA', description: data.error, variant: 'destructive' });
        return null;
      }
      return data?.result || null;
    } catch (e) {
      trackAICall('content-summarizer', Math.round(performance.now() - start), false);
      console.error('Summarize error:', e);
      toast({ title: 'Erreur', description: 'Impossible de résumer le contenu', variant: 'destructive' });
      return null;
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const translate = useCallback(async (text: string, targetLang?: string): Promise<string | null> => {
    if (!text) return null;
    const lang = targetLang || getLanguage();
    setTranslateLoading(true);
    const start = performance.now();
    try {
      const { data, error } = await supabase.functions.invoke('zeus', {
        body: { domain: 'content', action: 'translate', text, targetLanguage: lang },
      });
      trackAICall('auto-translator', Math.round(performance.now() - start), !error && !data?.error);
      if (error) throw error;
      if (data?.error) {
        toast({ title: 'IA', description: data.error, variant: 'destructive' });
        return null;
      }
      return data?.result || null;
    } catch (e) {
      trackAICall('auto-translator', Math.round(performance.now() - start), false);
      console.error('Translate error:', e);
      toast({ title: 'Erreur', description: 'Impossible de traduire le contenu', variant: 'destructive' });
      return null;
    } finally {
      setTranslateLoading(false);
    }
  }, []);

  return {
    summarize,
    translate,
    summaryLoading,
    translateLoading,
    aiSummariesEnabled: prefs.aiSummariesEnabled,
    autoTranslateEnabled: prefs.autoTranslateEnabled,
  };
}
