import { forwardRef, useMemo } from 'react';
import { User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { imagePresets, optimizedImageUrl } from '@/lib/imageOptimize';

interface AvatarProps {
  src?: string | null;
  alt?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  moodEmoji?: string | null;
}

const sizeClasses = {
  xs: 'w-7 h-7',
  sm: 'w-9 h-9',
  md: 'w-10 h-10',
  lg: 'w-14 h-14',
  xl: 'w-20 h-20',
};

const moodSizeClasses = {
  xs: 'w-3 h-3 text-[8px] -bottom-0.5 -right-0.5',
  sm: 'w-4 h-4 text-[10px] -bottom-0.5 -right-0.5',
  md: 'w-5 h-5 text-[11px] -bottom-0.5 -right-0.5',
  lg: 'w-6 h-6 text-xs -bottom-1 -right-1',
  xl: 'w-8 h-8 text-sm -bottom-1 -right-1',
};

export const UserAvatar = forwardRef<HTMLDivElement, AvatarProps>(
  ({ src, alt, size = 'md', className, moodEmoji }, ref) => {
    const optimizedSrc = useMemo(() => {
      if (!src) return null;
      if (size === 'xl') return imagePresets.avatarLarge(src);
      return imagePresets.avatar(src);
    }, [src, size]);
    const moodBadge = moodEmoji ? (
      <span className={cn(
        'absolute rounded-full bg-card border border-border/50 flex items-center justify-center shadow-sm',
        moodSizeClasses[size]
      )}>
        {moodEmoji}
      </span>
    ) : null;

    if (!src) {
      return (
        <div 
          ref={ref}
          className={cn(
            'pulse-avatar flex items-center justify-center bg-secondary text-muted-foreground relative',
            sizeClasses[size],
            className
          )}
        >
          <User className={size === 'xs' ? 'w-3 h-3' : size === 'sm' ? 'w-4 h-4' : size === 'xl' ? 'w-10 h-10' : 'w-5 h-5'} />
          {moodBadge}
        </div>
      );
    }

    return (
      <div ref={ref} className={cn(sizeClasses[size], 'relative', className)}>
        <img
          src={src}
          alt={alt || 'Avatar'}
          className={cn('pulse-avatar object-cover w-full h-full')}
        />
        {moodBadge}
      </div>
    );
  }
);

UserAvatar.displayName = 'UserAvatar';
