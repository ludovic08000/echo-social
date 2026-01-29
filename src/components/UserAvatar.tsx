import { User } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AvatarProps {
  src?: string | null;
  alt?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const sizeClasses = {
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
  lg: 'w-14 h-14',
  xl: 'w-20 h-20',
};

export function UserAvatar({ src, alt, size = 'md', className }: AvatarProps) {
  if (!src) {
    return (
      <div 
        className={cn(
          'pulse-avatar flex items-center justify-center bg-secondary text-muted-foreground',
          sizeClasses[size],
          className
        )}
      >
        <User className={size === 'sm' ? 'w-4 h-4' : size === 'xl' ? 'w-10 h-10' : 'w-5 h-5'} />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt || 'Avatar'}
      className={cn('pulse-avatar object-cover', sizeClasses[size], className)}
    />
  );
}
