import { cn } from '@/lib/utils';

interface ProtectedMediaProps {
  src: string;
  alt?: string;
  type?: 'image' | 'video';
  className?: string;
  watermarkText?: string;
}

export function ProtectedMedia({ src, alt, type = 'image', className, watermarkText = 'ForSure' }: ProtectedMediaProps) {
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.preventDefault();
  };

  return (
    <div className="relative select-none group" onContextMenu={handleContextMenu}>
      {type === 'image' ? (
        <img
          src={src}
          alt={alt || ''}
          className={cn('pointer-events-none', className)}
          draggable={false}
          onDragStart={handleDragStart}
        />
      ) : (
        <video
          src={src}
          className={cn('pointer-events-none', className)}
          controls
          controlsList="nodownload"
          disablePictureInPicture
          onContextMenu={handleContextMenu}
        />
      )}
      {/* Invisible overlay to prevent screenshot tools from grabbing just the image */}
      <div 
        className="absolute inset-0 z-10" 
        onContextMenu={handleContextMenu}
        onDragStart={handleDragStart}
        style={{ WebkitUserSelect: 'none', userSelect: 'none' }}
      />
      {/* Watermark */}
      <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <span 
          className="text-foreground/10 text-4xl font-bold rotate-[-30deg] select-none"
          style={{ textShadow: '0 0 10px rgba(0,0,0,0.1)' }}
        >
          {watermarkText}
        </span>
      </div>
    </div>
  );
}
