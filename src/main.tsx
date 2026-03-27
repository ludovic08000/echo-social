import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// ─── Crypto hardening: start integrity monitor at boot ───
import { startIntegrityMonitor, hardenPrototypes, onAutoWipe, onTamperDetected } from '@/lib/crypto';

hardenPrototypes();
startIntegrityMonitor(15_000); // Check every 15s

onTamperDetected((reason) => {
  console.error('[BOOT] Crypto tamper detected:', reason);
});

onAutoWipe(() => {
  console.error('[BOOT] Auto-wipe triggered — forcing reload');
  window.location.href = '/login';
});

createRoot(document.getElementById("root")!).render(<App />);
