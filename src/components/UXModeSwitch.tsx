import { useUXMode } from '@/hooks/useUXMode';
import { motion } from 'framer-motion';
import { Zap, Waves } from 'lucide-react';
import { cn } from '@/lib/utils';

export function UXModeSwitch({ className }: { className?: string }) {
  const { mode, toggleMode } = useUXMode();

  return (
    <button
      onClick={toggleMode}
      className={cn(
        'relative flex items-center gap-2 rounded-2xl p-1 transition-all duration-500',
        mode === 'flow'
          ? 'bg-gradient-to-r from-[hsl(340,70%,45%)] to-[hsl(310,55%,42%)] border border-[hsl(335,65%,55%,0.4)]'
          : 'bg-secondary/60 border border-border/40',
        className
      )}
      title={mode === 'focus' ? 'Passer en mode Flow' : 'Passer en mode Focus'}
    >
      {/* Animated pill */}
      <motion.div
        className={cn(
          'absolute top-1 bottom-1 rounded-xl',
          mode === 'flow'
            ? 'bg-[hsl(320,50%,55%,0.4)] border border-[hsl(320,55%,60%,0.3)]'
            : 'bg-white/[0.12] border border-white/[0.1]'
        )}
        initial={false}
        animate={{
          left: mode === 'focus' ? '4px' : 'calc(50%)',
          width: 'calc(50% - 4px)',
        }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      />

      <div className={cn(
        'relative z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-colors duration-300',
        mode === 'focus' ? 'text-foreground' : 'text-white/40'
      )}>
        <Zap className="w-3.5 h-3.5" />
        <span className="text-[11px] font-bold uppercase tracking-wider">Focus</span>
      </div>

      <div className={cn(
        'relative z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-colors duration-300',
        mode === 'flow' ? 'text-white' : 'text-muted-foreground'
      )}>
        <Waves className="w-3.5 h-3.5" />
        <span className="text-[11px] font-bold uppercase tracking-wider">Flow</span>
      </div>
    </button>
  );
}

/** Compact version for mobile header */
export function UXModeSwitchCompact({ className }: { className?: string }) {
  const { mode, toggleMode, isFlow } = useUXMode();

  return (
    <button
      onClick={toggleMode}
      className={cn(
        'relative w-9 h-9 rounded-full flex items-center justify-center transition-all duration-500',
        isFlow
          ? 'bg-gradient-to-br from-[hsl(330,50%,48%)] to-[hsl(280,50%,42%)] text-white shadow-[0_0_16px_hsl(320,55%,50%,0.35)]'
          : 'bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary',
        className
      )}
      title={mode === 'focus' ? 'Mode Flow' : 'Mode Focus'}
    >
      <motion.div
        initial={false}
        animate={{ rotate: isFlow ? 180 : 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      >
        {isFlow ? <Waves className="w-[18px] h-[18px]" /> : <Zap className="w-[18px] h-[18px]" />}
      </motion.div>
    </button>
  );
}
