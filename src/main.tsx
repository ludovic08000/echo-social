import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App.tsx";

// ─── Suppress harmless React ref warnings from third-party libs (Radix, framer-motion) ───
if (import.meta.env.DEV) {
  const origWarn = console.warn;
  const origError = console.error;
  const refMsg = 'Function components cannot be given refs';
  const refMsg2 = 'is not a prop';
  const filter = (orig: typeof console.warn) => (...args: unknown[]) => {
    if (typeof args[0] === 'string' && (args[0].includes(refMsg) || args[0].includes(refMsg2) || args[0].includes('Encountered two children with the same key') || args[0].includes('React Router Future Flag'))) return;
    orig(...args);
  };
  console.warn = filter(origWarn);
  console.error = filter(origError);
}
import "./index.css";

// ─── Runtime Shield: block XSS exploitation at boot ───
import { activateRuntimeShield } from '@/lib/runtimeShield';
activateRuntimeShield();

// ─── Build marker — confirms the new diagnostics build is active in runtime ───
console.info('[E2EE][BUILD] diagnostics-v3 active', { ts: new Date().toISOString() });

// Console guard disabled for debugging

// ─── Crypto hardening: prototype lock only (integrity monitor disabled — LiveKit legitimately wraps crypto.subtle) ───
import { hardenPrototypes } from '@/lib/crypto';

hardenPrototypes();

// ─── E2EE Session façade: wire pending message retry loop (Sesame-style) ───
import { wirePendingQueue } from '@/e2ee-session';
wirePendingQueue();

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <App />
  </HelmetProvider>
);
