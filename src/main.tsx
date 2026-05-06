import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import "./index.css";

if (import.meta.env.DEV) {
  const origWarn = console.warn;
  const origError = console.error;
  const refMsg = 'Function components cannot be given refs';
  const refMsg2 = 'is not a prop';

  const filter = (orig: typeof console.warn) => (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      (args[0].includes(refMsg) ||
        args[0].includes(refMsg2) ||
        args[0].includes('Encountered two children with the same key') ||
        args[0].includes('React Router Future Flag'))
    ) {
      return;
    }

    orig(...args);
  };

  console.warn = filter(origWarn);
  console.error = filter(origError);
}

async function hardResetRuntime() {
  try {
    indexedDB.deleteDatabase('forsure-msg-queue');
  } catch {}

  try {
    const databases = ['signal-protocol-store', 'forsure-e2ee', 'libsignal-meta'];
    for (const db of databases) {
      try {
        indexedDB.deleteDatabase(db);
      } catch {}
    }
  } catch {}

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {}

  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}

  console.info('[E2EE][BOOT] hard runtime reset complete');
}

async function bootstrap() {
  await hardResetRuntime();

  const [{ default: App }, { activateRuntimeShield }, crypto] = await Promise.all([
    import('./App.tsx'),
    import('@/lib/runtimeShield'),
    import('@/lib/crypto'),
  ]);

  activateRuntimeShield();
  crypto.hardenPrototypes();

  console.info('[E2EE][BUILD] hard-reset-active', {
    ts: new Date().toISOString(),
  });

  createRoot(document.getElementById('root')!).render(
    <HelmetProvider>
      <App />
    </HelmetProvider>,
  );
}

void bootstrap();
