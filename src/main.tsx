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
    ) return;

    orig(...args);
  };

  console.warn = filter(origWarn);
  console.error = filter(origError);
}

/**
 * One-shot cleanup of legacy non-crypto runtime caches.
 *
 * Originally this ran on EVERY boot, which:
 *  - wiped the message-queue IndexedDB (losing in-flight messages),
 *  - unregistered the PWA service worker on every load (defeating offline cache),
 *  - emptied all Cache Storage entries (cold-start every time),
 * and contributed to the Lovable preview iframe being marked as "stuck" /
 * blank because boot was significantly delayed.
 *
 * It's now gated by a localStorage marker so the cleanup runs exactly once
 * per browser, after which subsequent boots are fast and preserve queues.
 */
const CLEANUP_MARKER_KEY = 'forsure:legacy-cache-cleanup:v2';

async function cleanupNonCryptoRuntimeCaches() {
  try {
    if (localStorage.getItem(CLEANUP_MARKER_KEY) === '1') return;
  } catch {
    // localStorage blocked → skip cleanup entirely rather than running it every boot
    return;
  }

  try {
    indexedDB.deleteDatabase('forsure-msg-queue');
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

  try {
    localStorage.setItem(CLEANUP_MARKER_KEY, '1');
  } catch {}

  console.info('[BOOT] non-crypto runtime caches cleaned (one-shot)');
}


async function bootstrap() {
  await cleanupNonCryptoRuntimeCaches();

  const [
    { default: App },
    { activateRuntimeShield },
    crypto,
    identity,
    sessionInvalidation,
  ] = await Promise.all([
    import('./App.tsx'),
    import('@/lib/runtimeShield'),
    import('@/lib/crypto'),
    import('@/lib/crypto/identityBootstrap'),
    import('@/lib/crypto/sessionInvalidation'),
  ]);

  activateRuntimeShield();
  crypto.hardenPrototypes();

  identity.startIdentityBootstrap();
  sessionInvalidation.startSessionInvalidationWatcher();

  console.info('[E2EE][BUILD] protocol-bootstrap-active', {
    ts: new Date().toISOString(),
  });

  createRoot(document.getElementById('root')!).render(
    <HelmetProvider>
      <App />
    </HelmetProvider>,
  );
}

void bootstrap();
