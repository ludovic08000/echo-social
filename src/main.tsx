import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import "./index.css";
import { installGlobalCrashHandlers } from "@/lib/crashLogger";

// Install BEFORE anything else so the very first error (incl. during chunk
// loading or crypto bootstrap) is captured with full context.
installGlobalCrashHandlers();

// Console noise filter — keep ONLY real errors/warnings; mute verbose
// info/log/debug from crypto, E2EE, ML, X3DH, identity bootstrap, push,
// service worker, Vite HMR, third-party preview iframe noise, etc.
{
  const origLog = console.log;
  const origInfo = console.info;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;

  // Patterns that match purely informational chatter we don't need to see.
  const NOISE_PATTERNS: RegExp[] = [
    /^\[E2EE\]/i,
    /^\[X3DH\]/i,
    /^\[CRYPTO\]/i,
    /^\[KEY[_-]?SYNC\]/i,
    /^\[DEVICE\]/i,
    /^\[BOOT\]/i,
    /^\[ML\]/i,
    /^\[ZEUS\]/i,
    /^\[PUSH\]/i,
    /^\[SW\]/i,
    /^\[REALTIME\]/i,
    /^\[QUEUE\]/i,
    /^\[RATCHET\]/i,
    /^\[SENDER[_-]?KEY\]/i,
    /^\[KT\]/i,
    /^\[TRUST\]/i,
    /^\[SESSION\]/i,
    /\[vite\]/i,
    /Download the React DevTools/i,
    /React Router Future Flag/i,
    /Function components cannot be given refs/i,
    /Encountered two children with the same key/i,
    /is not a prop/i,
    /Unrecognized feature:/i,
    /allow-scripts and allow-same-origin/i,
    /preview_iframe_stuck_recovery/i,
    /feature_suggestions_message/i,
    /Failed to execute 'postMessage'/i,
    /ERR_BLOCKED_BY_CLIENT/i,
    /Content Security Policy directive/i,
    /An iframe which has both/i,
    /asynchronous response by returning true/i,
  ];

  const isNoise = (args: unknown[]) => {
    const first = args[0];
    if (typeof first !== 'string') return false;
    return NOISE_PATTERNS.some((re) => re.test(first));
  };

  const wrap =
    (orig: typeof console.log) =>
    (...args: unknown[]) => {
      if (isNoise(args)) return;
      orig(...args);
    };

  // Mute purely informational levels entirely (still wrap to allow [CRASH] etc.)
  console.log = wrap(origLog);
  console.info = wrap(origInfo);
  console.debug = wrap(origDebug);
  // Keep warn/error visible but drop the well-known noise
  console.warn = wrap(origWarn);
  console.error = wrap(origError);
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
  // Render the app ASAP so the Lovable preview iframe doesn't get marked
  // as "stuck" by its parent recovery watcher. Heavy crypto bootstrap is
  // deferred to after first paint.
  const { default: App } = await import('./App.tsx');

  createRoot(document.getElementById('root')!).render(
    <HelmetProvider>
      <App />
    </HelmetProvider>,
  );

  // Defer non-critical, heavy work to idle / post-paint
  const runDeferred = async () => {
    try {
      await cleanupNonCryptoRuntimeCaches();
    } catch {}

    try {
      const [
        { activateRuntimeShield },
        crypto,
        identity,
        sessionInvalidation,
      ] = await Promise.all([
        import('@/lib/runtimeShield'),
        import('@/lib/crypto'),
        import('@/lib/crypto/identityBootstrap'),
        import('@/lib/crypto/sessionInvalidation'),
        import('@/lib/security/e2eeDeviceTrustBootstrap'),
      ]);

      activateRuntimeShield();
      crypto.hardenPrototypes();
      identity.startIdentityBootstrap();
      sessionInvalidation.startSessionInvalidationWatcher();

      console.info('[E2EE][BUILD] protocol-bootstrap-active', {
        ts: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[BOOT] deferred init failed', err);
    }
  };

  const ric: typeof window.requestIdleCallback | undefined =
    (window as any).requestIdleCallback;
  if (ric) {
    ric(() => void runDeferred(), { timeout: 1500 });
  } else {
    setTimeout(() => void runDeferred(), 0);
  }
}

void bootstrap();
