import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import type { CrashContext } from '@/lib/crashLogger';
import { Button } from '@/components/ui/button';

interface Props {
  crash: CrashContext;
}

export function CrashDetails({ crash }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const text = JSON.stringify(crash, null, 2);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="w-full max-w-xl mt-4 text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        Détails techniques (premier crash)
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-border/60 bg-muted/40 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {crash.source} · {new Date(crash.ts).toLocaleTimeString()}
            </span>
            <Button size="sm" variant="ghost" onClick={copy} className="h-7 gap-1 text-xs">
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copié' : 'Copier'}
            </Button>
          </div>

          <div className="text-xs font-mono break-words">
            <span className="text-destructive">{crash.message}</span>
          </div>

          <div className="text-[11px] text-muted-foreground">
            Route: <span className="font-mono">{crash.route}</span>
          </div>

          <div className="text-[11px] text-muted-foreground">
            Crypto: subtle={String(crash.crypto.hasSubtle)} · idb=
            {String(crash.crypto.hasIndexedDB)} · keys=
            {crash.crypto.e2eeKeys.length}
          </div>

          {crash.stack && (
            <pre className="max-h-48 overflow-auto rounded-lg bg-background/60 p-2 text-[10px] leading-tight font-mono whitespace-pre-wrap">
              {crash.stack}
            </pre>
          )}

          {crash.componentStack && (
            <pre className="max-h-32 overflow-auto rounded-lg bg-background/60 p-2 text-[10px] leading-tight font-mono whitespace-pre-wrap">
              {crash.componentStack}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
