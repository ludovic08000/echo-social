import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTrustScore } from '@/hooks/useTrustAndSafety';

interface TrustBadgeProps {
  userId: string | undefined;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}

export function TrustBadge({ userId, size = 'sm', showLabel = false, className }: TrustBadgeProps) {
  const { data: trust } = useTrustScore(userId);

  if (!trust) return null;

  const score = trust.trust_score;
  const isFlagged = trust.is_flagged;

  let color = 'text-muted-foreground';
  let label = 'Nouveau';
  let Icon = Shield;

  if (isFlagged) {
    color = 'text-destructive';
    label = 'Signalé';
    Icon = ShieldAlert;
  } else if (score >= 80) {
    color = 'text-green-500';
    label = 'Très fiable';
    Icon = ShieldCheck;
  } else if (score >= 60) {
    color = 'text-primary';
    label = 'Fiable';
    Icon = ShieldCheck;
  } else if (score >= 40) {
    color = 'text-yellow-500';
    label = 'Modéré';
    Icon = Shield;
  } else {
    color = 'text-orange-500';
    label = 'Prudence';
    Icon = ShieldAlert;
  }

  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : size === 'md' ? 'w-4 h-4' : 'w-5 h-5';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex items-center gap-1', color, className)}>
          <Icon className={iconSize} />
          {showLabel && <span className="text-xs font-medium">{label}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-semibold">Score de confiance: {score}/100</p>
        <p className="text-xs text-muted-foreground">{label}</p>
        {trust.successful_sales > 0 && (
          <p className="text-xs">{trust.successful_sales} ventes réussies</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
