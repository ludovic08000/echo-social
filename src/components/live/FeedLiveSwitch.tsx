import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

interface FeedLiveSwitchProps {
  active: 'feed' | 'live';
  onChange: (tab: 'feed' | 'live') => void;
}

export function FeedLiveSwitch({ active, onChange }: FeedLiveSwitchProps) {
  return (
    <div className="relative flex items-center bg-white/5 backdrop-blur-xl rounded-full p-0.5 border border-white/10">
      {/* Animated pill background */}
      <motion.div
        className="absolute top-0.5 bottom-0.5 rounded-full"
        style={{
          background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%), hsl(190 80% 50%))',
        }}
        initial={false}
        animate={{
          left: active === 'feed' ? '2px' : '50%',
          width: 'calc(50% - 2px)',
        }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      />

      <button
        onClick={() => onChange('feed')}
        className={cn(
          'relative z-10 px-5 py-1.5 text-xs font-semibold rounded-full transition-colors flex-1',
          active === 'feed' ? 'text-white' : 'text-white/50'
        )}
      >
        Feed
      </button>
      <button
        onClick={() => onChange('live')}
        className={cn(
          'relative z-10 px-5 py-1.5 text-xs font-semibold rounded-full transition-colors flex-1',
          active === 'live' ? 'text-white' : 'text-white/50'
        )}
      >
        Live
      </button>
    </div>
  );
}
