import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

const POLL_INTERVAL_MS = 60 * 1000;
const VERSION_URL = '/version.json';
const VERSION_STORAGE_KEY = 'forsure:last-seen-build-version';
const RELOAD_LOCK_KEY = 'forsure:auto-reload-lock';

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string; builtAt?: string };
    return data?.version ?? data?.builtAt ?? null;
  } catch {
    return null;
  }
}

async function purgeRuntimeCaches(): Promise<void> {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {}

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(async (reg) => {
        try { await reg.update(); } catch {}
        if (reg.waiting) {
          try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch {}
        }
      }));
    }
  } catch {}
}

function shouldAutoReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_LOCK_KEY) || '0');
    if (last && Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_LOCK_KEY, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

async function applyNewVersion(version: string): Promise<void> {
  try { localStorage.setItem(VERSION_STORAGE_KEY, version); } catch {}
  await purgeRuntimeCaches();
  if (shouldAutoReload()) {
    window.location.reload();
  }
}

export function useVersionWatcher() {
  const initialVersionRef = useRef<string | null>(null);
  const updatingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      if (updatingRef.current) return;
      const version = await fetchVersion();
      if (!version || cancelled) return;

      let stored: string | null = null;
      try { stored = localStorage.getItem(VERSION_STORAGE_KEY); } catch {}

      if (initialVersionRef.current === null) {
        initialVersionRef.current = version;
        if (!stored) {
          try { localStorage.setItem(VERSION_STORAGE_KEY, version); } catch {}
          return;
        }
        if (stored !== version) {
          updatingRef.current = true;
          toast('Mise à jour du site', { description: 'Chargement automatique de la dernière version…', duration: 2500 });
          await applyNewVersion(version);
        }
        return;
      }

      if (version !== initialVersionRef.current) {
        updatingRef.current = true;
        toast('Mise à jour du site', { description: 'Chargement automatique de la dernière version…', duration: 2500 });
        await applyNewVersion(version);
      }
    };

    void check();
    const interval = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    const onFocus = () => void check();
    const onVisibility = () => { if (!document.hidden) void check(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
