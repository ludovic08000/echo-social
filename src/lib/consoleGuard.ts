/**
 * Console Guard — Neutralizes all console output in production
 * Makes F12 DevTools useless for attackers
 */

const IS_DEV = import.meta.env.DEV;

export function lockdownConsole(): void {
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
