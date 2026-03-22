import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { Sparkles, Users, Gamepad2, Music, MonitorSmartphone, Dumbbell, Car, Palette } from 'lucide-react';
import { motion } from 'framer-motion';

const CATEGORIES = [
  { id: 'pour-toi', label: 'Pour toi', icon: Sparkles },
  { id: 'suivis', label: 'Suivis', icon: Users },
  { id: 'gaming', label: 'Gaming', icon: Gamepad2 },
  { id: 'lifestyle', label: 'Lifestyle', icon: Palette },
  { id: 'musique', label: 'Musique', icon: Music },
  { id: 'tech', label: 'Tech', icon: MonitorSmartphone },
  { id: 'sport', label: 'Sport', icon: Dumbbell },
  { id: 'auto', label: 'Auto', icon: Car },
];

interface LiveCategoryChipsProps {
  active: string;
  onChange: (id: string) => void;
}

export function LiveCategoryChips({ active, onChange }: LiveCategoryChipsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={scrollRef}
      className="flex gap-1.5 overflow-x-auto scrollbar-none px-4 py-2.5"
    >
      {CATEGORIES.map((cat) => {
        const Icon = cat.icon;
        const isActive = active === cat.id;

        return (
          <motion.button
            key={cat.id}
            onClick={() => onChange(cat.id)}
            whileTap={{ scale: 0.95 }}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 rounded-xl text-[11px] font-semibold whitespace-nowrap transition-all duration-300 shrink-0 tracking-wide uppercase',
              isActive
                ? 'text-white bg-white/15 border border-white/20 shadow-lg backdrop-blur-md'
                : 'bg-white/[0.04] text-white/40 hover:bg-white/[0.08] hover:text-white/60 border border-transparent'
            )}
            style={isActive ? {
              boxShadow: '0 2px 16px hsl(var(--primary) / 0.15)',
            } : undefined}
          >
            <Icon className={cn("w-3.5 h-3.5", isActive && "text-primary")} />
            {cat.label}
          </motion.button>
        );
      })}
    </div>
  );
}
