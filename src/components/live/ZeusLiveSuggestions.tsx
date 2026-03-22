import { Sparkles, X } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface SuggestedLive {
  id: string;
  title: string;
  hostName: string;
  hostAvatar?: string | null;
  viewerCount: number;
  category: string;
}

interface ZeusLiveSuggestionsProps {
  suggestions: SuggestedLive[];
  onSelect: (id: string) => void;
}

export function ZeusLiveSuggestions({ suggestions, onSelect }: ZeusLiveSuggestionsProps) {
  const [visible, setVisible] = useState(true);

  if (!visible || suggestions.length === 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        className="mx-4 mb-2 rounded-2xl overflow-hidden backdrop-blur-xl border border-white/10"
        style={{
          background: 'linear-gradient(135deg, hsl(220 30% 15% / 0.85), hsl(260 20% 12% / 0.85))',
          boxShadow: '0 0 20px hsl(220 70% 55% / 0.1), inset 0 1px 0 hsl(220 70% 55% / 0.1)',
        }}
      >
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" style={{ color: 'hsl(190 80% 50%)' }} />
            <span className="text-[11px] font-semibold text-white/70">Zeus recommande</span>
          </div>
          <button onClick={() => setVisible(false)} className="text-white/30 hover:text-white/60 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </div>

        <div className="flex gap-2.5 overflow-x-auto scrollbar-none px-3 pb-2.5">
          {suggestions.map((s) => (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className="flex items-center gap-2 shrink-0 px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 transition-colors border border-white/5"
            >
              <UserAvatar src={s.hostAvatar} alt={s.hostName} size="xs" />
              <div className="text-left">
                <p className="text-white text-[10px] font-medium truncate max-w-[80px]">{s.hostName}</p>
                <p className="text-white/40 text-[9px]">{s.viewerCount} viewers</p>
              </div>
            </button>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
