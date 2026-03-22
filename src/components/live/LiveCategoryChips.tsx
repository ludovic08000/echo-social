import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { Sparkles, Users, Gamepad2, Music, MonitorSmartphone, Dumbbell, Car, Palette } from 'lucide-react';

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
      className="flex gap-2 overflow-x-auto scrollbar-none px-4 py-2"
    >
      {CATEGORIES.map((cat) => {
        const Icon = cat.icon;
        const isActive = active === cat.id;

        return (
          <button
            key={cat.id}
            onClick={() => onChange(cat.id)}
            className={cn(
              'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all duration-200 shrink-0',
              isActive
                ? 'text-white shadow-lg'
                : 'bg-white/8 text-white/50 hover:bg-white/12 hover:text-white/70 border border-white/5'
            )}
            style={isActive ? {
              background: 'linear-gradient(135deg, hsl(260 70% 50%), hsl(220 70% 55%), hsl(190 80% 50%))',
              boxShadow: '0 0 20px hsl(220 70% 55% / 0.3)',
            } : undefined}
          >
            <Icon className="w-3 h-3" />
            {cat.label}
          </button>
        );
      })}
    </div>
  );
}
