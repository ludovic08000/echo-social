import { useEffect, useState } from 'react';

const STORAGE_KEY = 'forsure:e2ee:trace';

type TraceRow = {
  at?: string;
  stage?: string;
  elapsedMs?: number;
  localId?: string;
  traceId?: string;
  conversationId?: string;
  error?: string;
  [key: string]: unknown;
};

function isDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  return url.searchParams.get('debug_e2ee') === '1' || localStorage.getItem('forsure:e2ee:debug') === '1';
}

function readRows(): TraceRow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-60) : [];
  } catch {
    return [];
  }
}

function clearRows() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function fmt(row: TraceRow): string {
  const stage = row.stage || 'unknown';
  const ms = typeof row.elapsedMs === 'number' ? `${row.elapsedMs}ms` : '';
  const err = row.error ? ` — ${String(row.error).slice(0, 120)}` : '';
  return `${row.at || ''} ${ms} ${stage}${err}`.trim();
}

export function E2EEDebugPanel() {
  const [enabled, setEnabled] = useState(false);
  const [rows, setRows] = useState<TraceRow[]>([]);

  useEffect(() => {
    const active = isDebugEnabled();
    setEnabled(active);
    if (!active) return;
    localStorage.setItem('forsure:e2ee:debug', '1');
    const refresh = () => setRows(readRows());
    refresh();
    const timer = window.setInterval(refresh, 700);
    window.addEventListener('forsure:e2ee-trace', refresh as EventListener);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('forsure:e2ee-trace', refresh as EventListener);
    };
  }, []);

  if (!enabled) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: 8,
        right: 8,
        bottom: 8,
        zIndex: 999999,
        maxHeight: '45vh',
        overflow: 'auto',
        background: 'rgba(10,12,18,0.94)',
        color: '#e9eefb',
        border: '1px solid rgba(255,255,255,0.22)',
        borderRadius: 12,
        padding: 10,
        fontSize: 11,
        lineHeight: 1.35,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        boxShadow: '0 12px 30px rgba(0,0,0,0.35)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <strong>E2EE TRACE</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => { clearRows(); setRows([]); }}
            style={{ fontSize: 11, padding: '4px 8px', borderRadius: 8, background: '#333a46', color: '#fff', border: '0' }}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => { localStorage.removeItem('forsure:e2ee:debug'); setEnabled(false); }}
            style={{ fontSize: 11, padding: '4px 8px', borderRadius: 8, background: '#5b2330', color: '#fff', border: '0' }}
          >
            Hide
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ opacity: 0.75 }}>Aucun trace. Envoie un message pour remplir ce panneau.</div>
      ) : (
        rows.map((row, idx) => (
          <div key={`${row.traceId || 't'}-${idx}`} style={{ borderTop: idx ? '1px solid rgba(255,255,255,0.12)' : '0', paddingTop: idx ? 5 : 0, marginTop: idx ? 5 : 0 }}>
            <div>{fmt(row)}</div>
            <div style={{ opacity: 0.65, wordBreak: 'break-all' }}>{row.localId || ''}</div>
          </div>
        ))
      )}
    </div>
  );
}
