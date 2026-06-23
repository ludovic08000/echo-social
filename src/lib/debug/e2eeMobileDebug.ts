const STORAGE_KEY = 'forsure:e2ee:trace';
const DEBUG_FLAG = 'forsure:e2ee:debug';

type TraceRow = Record<string, unknown> & {
  at?: string;
  stage?: string;
  elapsedMs?: number;
  error?: string;
};

function enabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('debug_e2ee') === '1' || localStorage.getItem(DEBUG_FLAG) === '1';
  } catch {
    return false;
  }
}

function read(): TraceRow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(-80) : [];
  } catch {
    return [];
  }
}

function write(row: TraceRow): void {
  try {
    const rows = read();
    rows.push({ at: new Date().toLocaleTimeString(), ...row });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(-80)));
    window.dispatchEvent(new CustomEvent('forsure:e2ee-trace'));
  } catch {}
}

function fmt(row: TraceRow): string {
  const ms = typeof row.elapsedMs === 'number' ? `${row.elapsedMs}ms` : '';
  const err = row.error ? ` — ${String(row.error).slice(0, 140)}` : '';
  return `${row.at || ''} ${ms} ${row.stage || 'unknown'}${err}`.trim();
}

function render(panel: HTMLElement): void {
  const rows = read();
  const items = rows.length
    ? rows.map((row) => `<div style="border-top:1px solid rgba(255,255,255,.12);padding:5px 0"><div>${escapeHtml(fmt(row))}</div><div style="opacity:.6;word-break:break-all">${escapeHtml(String(row.localId || ''))}</div></div>`).join('')
    : '<div style="opacity:.75">Aucun trace. Envoie un message.</div>';

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
      <strong>E2EE TRACE</strong>
      <div style="display:flex;gap:8px">
        <button data-e2ee-clear style="font-size:11px;padding:4px 8px;border-radius:8px;background:#333a46;color:#fff;border:0">Clear</button>
        <button data-e2ee-hide style="font-size:11px;padding:4px 8px;border-radius:8px;background:#5b2330;color:#fff;border:0">Hide</button>
      </div>
    </div>
    ${items}
  `;

  panel.querySelector('[data-e2ee-clear]')?.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    render(panel);
  });
  panel.querySelector('[data-e2ee-hide]')?.addEventListener('click', () => {
    localStorage.removeItem(DEBUG_FLAG);
    panel.remove();
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function installPanel(): void {
  if (!enabled()) return;
  localStorage.setItem(DEBUG_FLAG, '1');
  if (document.getElementById('forsure-e2ee-debug-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'forsure-e2ee-debug-panel';
  panel.style.cssText = [
    'position:fixed',
    'left:8px',
    'right:8px',
    'bottom:8px',
    'z-index:999999',
    'max-height:45vh',
    'overflow:auto',
    'background:rgba(10,12,18,.94)',
    'color:#e9eefb',
    'border:1px solid rgba(255,255,255,.22)',
    'border-radius:12px',
    'padding:10px',
    'font-size:11px',
    'line-height:1.35',
    'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
    'box-shadow:0 12px 30px rgba(0,0,0,.35)',
  ].join(';');
  document.body.appendChild(panel);
  render(panel);
  window.addEventListener('forsure:e2ee-trace', () => render(panel));
}

function installConsoleCapture(): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__forsureE2EEDebugInstalled) return;
  w.__forsureE2EEDebugInstalled = true;

  const originalInfo = console.info.bind(console);
  console.info = (...args: unknown[]) => {
    try {
      if (args[0] === '[MSG_TRACE]' && typeof args[1] === 'object' && args[1] !== null) {
        write(args[1] as TraceRow);
      }
    } catch {}
    originalInfo(...args);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installPanel, { once: true });
  } else {
    installPanel();
  }
}

installConsoleCapture();
