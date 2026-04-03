import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

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

createRoot(document.getElementById("root")!).render(<App />);
