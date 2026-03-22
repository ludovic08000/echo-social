import { Radio, Eye, Sparkles } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { motion } from 'framer-motion';

interface LiveInfoOverlayProps {
  hostName?: string;
  hostAvatar?: string | null;
  title: string;
  category?: string | null;
  viewerCount: number;
  isActive: boolean;
  zeusReason?: string;
}

export function LiveInfoOverlay({
  hostName,
  hostAvatar,
  title,
  category,
  viewerCount,
  isActive,
  zeusReason,
}: LiveInfoOverlayProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2, duration: 0.4 }}
      className="flex flex-col gap-2"
    >
      {/* Host info */}
      <div className="flex items-center gap-2.5">
        <div className="relative">
          <div className="rounded-full p-[2px]" style={{
            background: isActive ? 'linear-gradient(135deg, hsl(260 70% 55%), hsl(190 80% 50%))' : 'transparent',
          }}>
            <UserAvatar src={hostAvatar} alt={hostName} size="sm" />
          </div>
          {isActive && (
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-black"
              style={{ background: 'hsl(260 70% 55%)' }}
            />
          )}
        </div>
        <span className="text-white font-semibold text-sm drop-shadow-lg">
          @{hostName || 'utilisateur'}
        </span>
        {isActive && (
          <div
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-white"
            style={{
              background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%))',
              boxShadow: '0 0 12px hsl(260 70% 55% / 0.4)',
            }}
          >
            <Radio className="w-2.5 h-2.5 animate-pulse" />
            LIVE
          </div>
        )}
      </div>

      {/* Title */}
      <p className="text-white/90 text-[13px] leading-snug drop-shadow-lg line-clamp-2">
        {title}
      </p>

      {/* Category + viewers */}
      <div className="flex items-center gap-2 text-white/50 text-[11px]">
        {category && (
          <span className="capitalize">{category}</span>
        )}
        {category && <span>•</span>}
        <span className="flex items-center gap-1">
          <Eye className="w-3 h-3" />
          {formatViewerCount(viewerCount)}
        </span>
      </div>

      {/* Zeus recommendation */}
      {zeusReason && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 backdrop-blur-sm border border-white/10 w-fit">
          <Sparkles className="w-3 h-3" style={{ color: 'hsl(190 80% 50%)' }} />
          <span className="text-[10px] text-white/60">{zeusReason}</span>
        </div>
      )}
    </motion.div>
  );
}

function formatViewerCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}
