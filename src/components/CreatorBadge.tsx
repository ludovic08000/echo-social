import { Crown } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface CreatorBadgeProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = {
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
};

export function CreatorBadge({ size = 'sm', className }: CreatorBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn(
          'inline-flex items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-white shrink-0',
          size === 'sm' && 'w-4 h-4',
          size === 'md' && 'w-5 h-5',
          size === 'lg' && 'w-6 h-6',
          className
        )}>
          <Crown className={sizeMap[size]} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        Créateur vérifié
      </TooltipContent>
    </Tooltip>
  );
}
