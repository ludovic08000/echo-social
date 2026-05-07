import { useEffect, useState } from 'react';
import { FileText, Download, Loader2, FileSpreadsheet, FileArchive, FileType2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatBytes, type ParsedDocument } from '@/lib/messaging/documentMessage';
import { toast } from 'sonner';

interface Props {
  encryptedUrl: string;
  doc: ParsedDocument;
  isMe?: boolean;
}

function pickIcon(mime: string) {
  if (/pdf/.test(mime)) return FileType2;
  if (/sheet|excel/.test(mime)) return FileSpreadsheet;
  if (/zip/.test(mime)) return FileArchive;
  return FileText;
}

export function DocumentBubble({ encryptedUrl, doc, isMe }: Props) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const Icon = pickIcon(doc.mime);

  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  const decryptBlob = async (): Promise<Blob | null> => {
    try {
      const { importMediaKey, decryptMedia } = await import('@/lib/crypto/mediaEncrypt');
      const key = await importMediaKey(doc.keyB64);
      const res = await fetch(encryptedUrl);
      if (!res.ok) throw new Error('fetch failed');
      const enc = await res.arrayBuffer();
      const plain = await decryptMedia(enc, key);
      return new Blob([plain], { type: doc.mime || 'application/octet-stream' });
    } catch (e) {
      console.error('[doc] decrypt failed', e);
      return null;
    }
  };

  const handleDownload = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await decryptBlob();
      if (!blob) { toast.error('Déchiffrement impossible'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = doc.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } finally { setBusy(false); }
  };

  const handlePreview = async () => {
    if (busy || previewUrl) { if (previewUrl) window.open(previewUrl, '_blank'); return; }
    setBusy(true);
    try {
      const blob = await decryptBlob();
      if (!blob) { toast.error('Déchiffrement impossible'); return; }
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      window.open(url, '_blank');
    } finally { setBusy(false); }
  };

  const canPreview = /pdf|image\//.test(doc.mime);

  return (
    <div className={cn(
      'flex items-center gap-3 px-3 py-2.5 rounded-2xl min-w-[220px] max-w-[280px]',
      isMe ? 'bg-primary text-primary-foreground' : 'bg-secondary'
    )}>
      <div className={cn(
        'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0',
        isMe ? 'bg-primary-foreground/15' : 'bg-primary/10 text-primary'
      )}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium truncate">{doc.name}</p>
        <p className={cn('text-[10px]', isMe ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
          {formatBytes(doc.size)} · {doc.mime.split('/').pop()}
        </p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {canPreview && (
          <button
            onClick={handlePreview}
            disabled={busy}
            title="Aperçu"
            className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center transition',
              isMe ? 'bg-primary-foreground/15 hover:bg-primary-foreground/25'
                   : 'bg-primary/10 text-primary hover:bg-primary/20'
            )}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-4 h-4" />}
          </button>
        )}
        <button
          onClick={handleDownload}
          disabled={busy}
          title="Télécharger"
          className={cn(
            'w-8 h-8 rounded-full flex items-center justify-center transition',
            isMe ? 'bg-primary-foreground/15 hover:bg-primary-foreground/25'
                 : 'bg-primary/10 text-primary hover:bg-primary/20'
          )}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
