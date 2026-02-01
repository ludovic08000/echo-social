import { useState } from 'react';
import { Share2, Copy, Check, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/hooks/use-toast';
import { shareUrl, ShareData } from '@/lib/urlUtils';
import { cn } from '@/lib/utils';

interface ShareButtonProps {
  url: string;
  title?: string;
  text?: string;
  variant?: 'default' | 'ghost' | 'outline' | 'secondary';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
  showLabel?: boolean;
}

export function ShareButton({
  url,
  title,
  text,
  variant = 'ghost',
  size = 'icon',
  className,
  showLabel = false,
}: ShareButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const shareData: ShareData = { url, title, text };
    const success = await shareUrl(shareData);
    
    if (success) {
      setCopied(true);
      toast({
        title: 'Lien copié !',
        description: 'Le lien a été copié dans votre presse-papiers',
      });
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast({
        title: 'Erreur',
        description: 'Impossible de partager le lien',
        variant: 'destructive',
      });
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast({
        title: 'Lien copié !',
        description: 'Le lien a été copié dans votre presse-papiers',
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: 'Erreur',
        description: 'Impossible de copier le lien',
        variant: 'destructive',
      });
    }
  };

  // On mobile, use Web Share API directly
  if (navigator.share) {
    return (
      <Button
        variant={variant}
        size={size}
        onClick={handleShare}
        className={cn('gap-2', className)}
      >
        {copied ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
        {showLabel && <span>Partager</span>}
      </Button>
    );
  }

  // On desktop, show dropdown with options
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} className={cn('gap-2', className)}>
          {copied ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
          {showLabel && <span>Partager</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={copyToClipboard}>
          <Copy className="w-4 h-4 mr-2" />
          Copier le lien
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => window.open(`https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text || title || '')}`, '_blank')}>
          <span className="w-4 h-4 mr-2 text-center">𝕏</span>
          Partager sur X
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, '_blank')}>
          <span className="w-4 h-4 mr-2 text-center">f</span>
          Partager sur Facebook
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent((text || title || '') + ' ' + url)}`, '_blank')}>
          <span className="w-4 h-4 mr-2 text-center">W</span>
          Partager sur WhatsApp
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
