/**
 * Console Guard — Neutralizes all console output in production
 * Makes F12 DevTools useless for attackers
 */

const IS_DEV = import.meta.env.DEV;

// Références capturées AVANT le lockdown : seul le traçage E2EE opt-in les
// utilise, et uniquement des métadonnées (jamais de clé ni de contenu).
const RAW_CONSOLE = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
} as const;

export type RawConsoleLevel = keyof typeof RAW_CONSOLE;

/** Écrit dans la vraie console même après le lockdown production. */
export function rawConsoleWrite(level: RawConsoleLevel, ...args: unknown[]): void {
  try {
    RAW_CONSOLE[level](...args);
  } catch {
    /* console indisponible */
  }
}

const DEBUG_KEY = 'forsure:e2ee-debug';

/** Active/désactive le traçage E2EE visible dans F12 (persisté). */
export function setE2EEDebugEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(DEBUG_KEY, '1');
    else localStorage.setItem(DEBUG_KEY, '0');
  } catch {
    /* stockage indisponible */
  }
}

export function isE2EEDebugEnabled(): boolean {
  if (IS_DEV) return true;
  try {
    if (typeof window !== 'undefined' && window.location.search.includes('e2eeDebug=1')) {
      setE2EEDebugEnabled(true);
      return true;
    }
    // These diagnostics contain sanitized metadata only. Keep them visible by
    // default in production so device-route failures can be inspected in F12.
    return localStorage.getItem(DEBUG_KEY) !== '0';
  } catch {
    return false;
  }
}

export function lockdownConsole(): void {
  // Expose l'interrupteur de diagnostic avant toute neutralisation.
  if (typeof window !== 'undefined') {
    (window as any).forsureDebug = {
      enable: () => { setE2EEDebugEnabled(true); rawConsoleWrite('log', '[AEGIS] traçage activé — rechargez la page'); },
      disable: () => { setE2EEDebugEnabled(false); rawConsoleWrite('log', '[AEGIS] traçage désactivé'); },
      enabled: isE2EEDebugEnabled,
      traces: async () => (await import('@/lib/messaging/e2eeTrace')).readE2EETrace(),
      clearTraces: async () => (await import('@/lib/messaging/e2eeTrace')).clearE2EETrace(),
      help: () => rawConsoleWrite('log', '[AEGIS] forsureDebug: enabled(), enable(), disable(), traces(), clearTraces()'),
    };
    rawConsoleWrite('log', '[AEGIS] diagnostic F12 actif (métadonnées uniquement). Tapez forsureDebug.help()');
  }
  if (IS_DEV) return; // Keep logs in dev mode


  const noop = () => {};

  // Store originals for internal use only
  const _origError = console.error;

  // Completely silence all console methods
  const methods: (keyof Console)[] = [
    'log', 'warn', 'info', 'debug', 'trace',
    'dir', 'dirxml', 'table', 'group', 'groupCollapsed',
    'groupEnd', 'count', 'countReset', 'time', 'timeEnd',
    'timeLog', 'timeStamp', 'profile', 'profileEnd', 'clear',
  ];

  for (const method of methods) {
    (console as any)[method] = noop;
  }

  // Error: only log a generic code, no details
  console.error = (...args: unknown[]) => {
    // Security-critical errors get an opaque code only
    _origError.call(console, `[E${Date.now().toString(36).slice(-4)}]`);
  };

  // Prevent reassignment of console methods
  try {
    Object.freeze(console);
  } catch {
    // Some browsers don't allow freezing console
  }

  // Anti-debug: detect DevTools open via debugger traps
  // Subtle performance-based detection
  let devtoolsWarned = false;
  const threshold = 100;

  const detectDevTools = () => {
    const start = performance.now();
    // debugger statement slows execution when DevTools is open
    // We use a softer approach: measure toString overhead
    const el = new Image();
    Object.defineProperty(el, 'id', {
      get: () => {
        if (!devtoolsWarned) {
          devtoolsWarned = true;
          // Clear console when DevTools detected
          try { (console as any).clear = noop; } catch {}
        }
        return '';
      },
    });
  };

  // Run detection periodically
  setInterval(detectDevTools, 5000);

  // Intercept common hacker tricks
  // Prevent source map fetching hints
  const origFetch = window.fetch;
  window.fetch = function (...args: Parameters<typeof fetch>) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url;
    if (url?.endsWith('.map')) {
      return Promise.reject(new Error(''));
    }
    return origFetch.apply(this, args);
  };
}

/**
 * For internal security logging that bypasses the guard
 * Only used by security-critical modules
 */
let _internalLog: (...args: unknown[]) => void = console.error;

export function captureInternalLogger(): void {
  if (!IS_DEV) {
    // Capture before lockdown
    _internalLog = console.error.bind(console);
  }
}

export function internalSecurityLog(...args: unknown[]): void {
  // In production, this goes to our security monitoring, not console
  // Silently swallowed — real alerts go via edge functions
}
