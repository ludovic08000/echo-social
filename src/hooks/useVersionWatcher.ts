import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

/**
 * Détecte une nouvelle version déployée du site sans que l'utilisateur
 * ait à vider son cache. Récupère /version.json (servi sans cache) toutes
 * les 5 minutes + au focus de l'onglet. Si la version a changé,
 * affiche un toast "Mise à jour disponible — Recharger".
 */
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const VERSION_URL = '/version.json';

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data?.version ?? null;
  } catch {
    return null;
  }
}

export function useVersionWatcher() {
  const initialVersionRef = useRef<string | null>(null);
  const promptedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const v = await fetchVersion();
      if (!v || cancelled) return;

      if (initialVersionRef.current === null) {
        initialVersionRef.current = v;
        return;
      }

      if (v !== initialVersionRef.current && !promptedRef.current) {
        promptedRef.current = true;
        toast('Nouvelle version disponible', {
          description: 'Rechargez pour profiter des dernières améliorations.',
          duration: Infinity,
          action: {
            label: 'Recharger',
            onClick: () => window.location.reload(),
          },
        });
      }
    };

    void check();
    const interval = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);
}
