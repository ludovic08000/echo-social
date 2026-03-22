import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

interface FeedLiveSwitchProps {
  active: 'feed' | 'live';
  onChange: (tab: 'feed' | 'live') => void;
}

export function FeedLiveSwitch({ active, onChange }: FeedLiveSwitchProps) {
  return (
    <div className="relative flex items-center bg-white/[0.06] backdrop-blur-2xl rounded-2xl p-1 border border-white/[0.08]">
      {/* Animated pill */}
      <motion.div
        className="absolute top-1 bottom-1 rounded-xl bg-white/[0.12] border border-white/[0.1]"
        initial={false}
        animate={{
          left: active === 'feed' ? '4px' : '50%',
          width: 'calc(50% - 4px)',
        }}
        transition={{ type: 'spring', stiffness: 500, damping: 35 }}
      />

      <button
        onClick={() => onChange('feed')}
        className={cn(
          'relative z-10 px-6 py-2 text-[11px] font-bold uppercase tracking-[0.08em] rounded-xl transition-colors flex-1',
          active === 'feed' ? 'text-white' : 'text-white/35'
        )}
      >
        Feed
      </button>
      <button
        onClick={() => onChange('live')}
        className={cn(
          'relative z-10 px-6 py-2 text-[11px] font-bold uppercase tracking-[0.08em] rounded-xl transition-colors flex-1',
          active === 'live' ? 'text-white' : 'text-white/35'
        )}
      >
        Live
      </button>
    </div>
  );
}
