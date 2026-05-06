import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import "./index.css";

// ─── Suppress harmless React ref warnings from third-party libs ───
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

async function clearLegacyOutboundQueue(): Promise<void> {
  try {
    const req = indexedDB.deleteDatabase('forsure-msg-queue');
    await new Promise<void>((resolve) => {
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    console.info('[E2EE][QUEUE] legacy outbound queue cleared at boot');
  } catch (error) {
    console.warn('[E2EE][QUEUE] boot queue cleanup skipped', error);
  }
}

async function bootstrap() {
  await clearLegacyOutboundQueue();

  const [{ default: App }, { activateRuntimeShield }, crypto] = await Promise.all([
    import('./App.tsx'),
    import('@/lib/runtimeShield'),
    import('@/lib/crypto'),
  ]);

  activateRuntimeShield();
  crypto.hardenPrototypes();

  console.info('[E2EE][BUILD] queue-loop-fix active', { ts: new Date().toISOString() });

  // The legacy e2ee-session pending retry loop is intentionally not wired at boot.
  // Message sending is handled by the chat hook and recovery flow instead.
  // import('@/e2ee-session').then(({ wirePendingQueue }) => wirePendingQueue());

  createRoot(document.getElementById('root')!).render(
    <HelmetProvider>
      <App />
    </HelmetProvider>,
  );
}

void bootstrap();
