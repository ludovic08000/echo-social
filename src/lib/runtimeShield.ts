/**
 * Runtime Shield — Makes XSS/JS injection unexploitable even if injected
 * Grade militaire: gel APIs, anti-DOM-injection, proxy cookies, kill eval
 */

const IS_DEV = import.meta.env.DEV;

// ─── 1. Freeze critical network APIs ───
function freezeNetworkAPIs() {
  if (IS_DEV) return;

  // Snapshot originals
  const origFetch = window.fetch;
  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;

  // Whitelist: only allow requests to our own domains
  const ALLOWED_ORIGINS = [
    window.location.origin,
    'https://vkpmoqfzrihcijjochks.supabase.co',
    'https://vkpmoqfzrihcijjochks.functions.supabase.co',
    'https://forsure.fans',
    'https://api.giphy.com',
    'https://tenor.googleapis.com',
  ];

  const isAllowedURL = (url: string | URL | Request): boolean => {
    try {
      const href = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString();
      // Relative URLs are always allowed
      if (href.startsWith('/') && !href.startsWith('//')) return true;
      const parsed = new URL(href, window.location.origin);
      if (parsed.hostname.endsWith('.r2.cloudflarestorage.com')) return true;
      return ALLOWED_ORIGINS.some(o => parsed.origin === o || parsed.origin === new URL(o).origin);
    } catch {
      return false;
    }
  };

  // Harden fetch — block exfiltration
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!isAllowedURL(input as string | URL | Request)) {
      return Promise.reject(new TypeError('Network request blocked'));
    }
    return origFetch.call(this, input, init);
  } as typeof fetch;

  // Harden XHR
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    if (!isAllowedURL(url)) {
      throw new TypeError('Network request blocked');
    }
    return origXHROpen.call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  // Freeze prototypes
  try {
    Object.freeze(XMLHttpRequest.prototype);
  } catch {}

  // Block WebSocket to foreign origins
  const OrigWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(OrigWebSocket, {
    construct(target, args) {
      const wsUrl = args[0] as string;
      try {
        const parsed = new URL(wsUrl);
        const allowed = ALLOWED_ORIGINS.some(o => {
          const orig = new URL(o);
          return parsed.hostname === orig.hostname;
        });
        if (!allowed) throw new Error('WebSocket blocked');
      } catch (e) {
        if ((e as Error).message === 'WebSocket blocked') throw e;
      }
      return new target(...(args as [string, string?]));
    },
  }) as any;

  // Block EventSource
  try {
    Object.defineProperty(window, 'EventSource', {
      value: undefined,
      writable: false,
      configurable: false,
    });
  } catch {}

  // Block sendBeacon exfiltration
  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
      if (!isAllowedURL(url)) return false;
      return origBeacon(url, data);
    };
  }
}

// ─── 2. DOM Injection Monitor ───
function startDOMShield() {
  if (IS_DEV) return;

  const DANGEROUS_TAGS = new Set([
    'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'APPLET',
    'FORM', 'BASE', 'LINK',
  ]);

  const isSafe = (node: Node): boolean => {
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    const el = node as Element;
    const tag = el.tagName;

    // Allow our own scripts (vite, app bundles)
    if (tag === 'SCRIPT') {
      const src = el.getAttribute('src') || '';
      if (src.startsWith('/') && !src.startsWith('//')) return true;
      if (src.includes(window.location.origin)) return true;
      // Inline scripts with type=application/ld+json are OK (SEO)
      if (el.getAttribute('type') === 'application/ld+json') return true;
      // Inline module scripts from Vite
      if (el.getAttribute('type') === 'module' && !src) return true;
      return false;
    }

    // Allow our own link/stylesheets
    if (tag === 'LINK') {
      const href = el.getAttribute('href') || '';
      if (href.startsWith('/') || href.includes(window.location.origin)) return true;
      if (href.includes('fonts.googleapis.com') || href.includes('fonts.gstatic.com')) return true;
      return false;
    }

    if (DANGEROUS_TAGS.has(tag)) return false;

    // Check for inline event handlers
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }

    // Check for javascript: URLs
    const href = el.getAttribute('href');
    if (href && href.trim().toLowerCase().startsWith('javascript:')) {
      el.removeAttribute('href');
    }

    return true;
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (!isSafe(node)) {
          node.parentNode?.removeChild(node);
        }
        // Also check children of added nodes
        if (node.nodeType === Node.ELEMENT_NODE) {
          const children = (node as Element).querySelectorAll('script, iframe, object, embed, applet, base');
          children.forEach(child => {
            if (!isSafe(child)) {
              child.parentNode?.removeChild(child);
            }
          });
        }
      }

      // Check attribute changes for event handlers
      if (mutation.type === 'attributes' && mutation.target.nodeType === Node.ELEMENT_NODE) {
        const el = mutation.target as Element;
        const attr = mutation.attributeName;
        if (attr?.startsWith('on')) {
          el.removeAttribute(attr);
        }
        if (attr === 'href') {
          const val = el.getAttribute('href');
          if (val?.trim().toLowerCase().startsWith('javascript:')) {
            el.removeAttribute('href');
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'src', 'action', 'formaction',
      'onclick', 'onerror', 'onload', 'onmouseover', 'onfocus', 'onblur'],
  });
}

// ─── 3. Kill eval & dangerous constructors ───
function killEval() {
  if (IS_DEV) return;

  // Block eval
  try {
    Object.defineProperty(window, 'eval', {
      value: () => { throw new Error('Blocked'); },
      writable: false,
      configurable: false,
    });
  } catch {}

  // Block Function constructor (new Function('...'))
  try {
    const origFunction = Function;
    const SafeFunction = function (...args: any[]) {
      throw new Error('Blocked');
    } as any;
    SafeFunction.prototype = origFunction.prototype;
    Object.defineProperty(window, 'Function', {
      value: SafeFunction,
      writable: false,
      configurable: false,
    });
  } catch {}

  // Block string-based setTimeout/setInterval
  const origSetTimeout = window.setTimeout;
  const origSetInterval = window.setInterval;

  (window as any).setTimeout = function (handler: any, ...rest: any[]) {
    if (typeof handler === 'string') throw new Error('Blocked');
    return origSetTimeout(handler, ...rest);
  };

  (window as any).setInterval = function (handler: any, ...rest: any[]) {
    if (typeof handler === 'string') throw new Error('Blocked');
    return origSetInterval(handler, ...rest);
  };
}

// ─── 4. Cookie protection ───
function protectCookies() {
  if (IS_DEV) return;

  // Block JS access to document.cookie entirely
  try {
    Object.defineProperty(document, 'cookie', {
      get: () => '',
      set: () => {},
      configurable: false,
    });
  } catch {}
}

// ─── 5. Prototype pollution shield ───
function shieldPrototypes() {
  if (IS_DEV) return;

  // Freeze Object.prototype and Array.prototype to prevent pollution
  try {
    Object.freeze(Object.prototype);
  } catch {}

  try {
    Object.freeze(Array.prototype);
  } catch {}

  // Block __proto__ access
  try {
    Object.defineProperty(Object.prototype, '__proto__', {
      get: function () { return Object.getPrototypeOf(this); },
      set: function () { /* blocked */ },
    });
  } catch {}
}

// ─── Main activation ───
export function activateRuntimeShield(): void {
  freezeNetworkAPIs();
  killEval();
  protectCookies();
  shieldPrototypes();

  // DOM shield must wait for document to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDOMShield, { once: true });
  } else {
    startDOMShield();
  }
}
