import { useEffect, useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import { downloadMatrixAttachment, type MatrixMessage } from '@/lib/matrix';
import { cn } from '@/lib/utils';

type Props = {
  file: NonNullable<MatrixMessage['file']>;
  isMe: boolean;
};

export function MatrixAttachmentBubble({ file, isMe }: Props) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isImage = file.mimeType.startsWith('image/');
  const isVideo = file.mimeType.startsWith('video/');

  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  const load = async () => {
    if (loading || objectUrl) return;
    setLoading(true);
    try {
      const downloaded = await downloadMatrixAttachment(file.encryptedFile, file.mimeType);
      setObjectUrl(downloaded.objectUrl);
    } finally {
      setLoading(false);
    }
  };

  if (objectUrl && isImage) {
    return <img src={objectUrl} alt={file.name} className="max-w-[260px] rounded-xl" />;
  }
  if (objectUrl && isVideo) {
    return <video src={objectUrl} controls playsInline className="max-w-[280px] rounded-xl" />;
  }

  return (
    <button
      type="button"
      onClick={() => void load()}
      className={cn(
        'flex max-w-[280px] items-center gap-3 rounded-xl px-3 py-2 text-left',
        isMe ? 'bg-primary text-primary-foreground' : 'bg-secondary',
      )}
    >
      {loading
        ? <Loader2 className="h-5 w-5 animate-spin" />
        : file.mimeType === 'application/pdf'
          ? <FileText className="h-5 w-5" />
          : <Download className="h-5 w-5" />}
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{file.name}</span>
        <span className="block text-[10px] opacity-70">
          {Math.max(1, Math.round(file.size / 1024))} Ko
        </span>
      </span>
    </button>
  );
}

