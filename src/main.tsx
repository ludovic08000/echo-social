import { createRoot } from "react-dom/client";
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

// ─── Console lockdown: must run BEFORE any other import logs ───
import { captureInternalLogger, lockdownConsole } from '@/lib/consoleGuard';
captureInternalLogger();
lockdownConsole();

// ─── Crypto hardening: start integrity monitor at boot ───
import { startIntegrityMonitor, hardenPrototypes, onAutoWipe, onTamperDetected } from '@/lib/crypto';

hardenPrototypes();
startIntegrityMonitor(15_000);

onTamperDetected(() => {
  // Silent — no info leak
});

onAutoWipe(() => {
  window.location.href = '/login';
});

// ─── E2EE trusted browser/device bootstrap ───
import '@/lib/security/e2eeDeviceTrustBootstrap';

createRoot(document.getElementById("root")!).render(<App />);
