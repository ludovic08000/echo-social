import { forwardRef } from 'react';
import { User } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AvatarProps {
  src?: string | null;
  alt?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const sizeClasses = {
  xs: 'w-6 h-6',
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
  lg: 'w-14 h-14',
  xl: 'w-20 h-20',
};

export const UserAvatar = forwardRef<HTMLDivElement, AvatarProps>(
  ({ src, alt, size = 'md', className }, ref) => {
    if (!src) {
      return (
        <div 
          ref={ref}
          className={cn(
            'pulse-avatar flex items-center justify-center bg-secondary text-muted-foreground',
            sizeClasses[size],
            className
          )}
        >
          <User className={size === 'xs' ? 'w-3 h-3' : size === 'sm' ? 'w-4 h-4' : size === 'xl' ? 'w-10 h-10' : 'w-5 h-5'} />
        </div>
      );
    }

    return (
      <div ref={ref} className={cn(sizeClasses[size], className)}>
        <img
          src={src}
          alt={alt || 'Avatar'}
          className={cn('pulse-avatar object-cover w-full h-full', className)}
        />
      </div>
    );
  }
);

UserAvatar.displayName = 'UserAvatar';
