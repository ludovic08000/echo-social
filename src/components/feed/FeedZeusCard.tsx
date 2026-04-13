import { Zap, MessageSquare, Sparkles, PenLine, Search, Globe } from 'lucide-react';
import { motion } from 'framer-motion';
import { useZeusSettings } from '@/hooks/useZeusCompanion';
import { useAuth } from '@/lib/auth';

const ZEUS_ACTIONS = [
  { icon: PenLine, label: 'Créer un post', action: 'create-post' },
  { icon: Search, label: 'Rechercher', action: 'search' },
  { icon: Globe, label: 'Traduire', action: 'translate' },
  { icon: Sparkles, label: 'Idées', action: 'ideas' },
];

export function FeedZeusCard() {
  const { user } = useAuth();
  const { zeusName } = useZeusSettings();

  const guestQuestions = parseInt(localStorage.getItem('forsure-zeus-guest-count') || '0', 10);
  const guestLimitReached = !user && guestQuestions >= 3;

  const openZeus = (action?: string) => {
    window.dispatchEvent(new CustomEvent('open-zeus', { detail: action ? { action } : undefined }));
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="px-4 mb-4"
    >
      <div
        className="relative overflow-hidden rounded-2xl border border-primary/15 transition-all duration-300 hover:border-primary/25 hover:shadow-[var(--shadow-lg)]"
        style={{
          background: 'linear-gradient(135deg, hsl(var(--card)) 0%, hsl(var(--accent)) 100%)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        {/* Top accent */}
        <div className="h-[2px] w-full bg-[image:var(--premium-gradient)]" />

        {/* Main CTA */}
        <button
          onClick={() => openZeus()}
          className="w-full p-4 pb-3 text-left group cursor-pointer relative"
        >
          <div className="flex items-center gap-3">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center text-primary-foreground relative shrink-0"
              style={{
                background: 'var(--premium-gradient)',
                boxShadow: 'var(--shadow-gold)',
              }}
            >
              <Zap className="w-6 h-6" />
              <motion.div
                animate={{ opacity: [0.4, 0.8, 0.4] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="absolute inset-0 rounded-2xl"
                style={{ boxShadow: '0 0 20px hsl(var(--primary) / 0.3)' }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-foreground tracking-tight">
                {zeusName} <span className="text-primary">⚡</span>
                <span className="text-muted-foreground font-normal text-xs ml-1.5">— IA Copilote</span>
              </p>
              <p className="text-[12px] text-muted-foreground mt-0.5 leading-snug">
                Demande-moi n'importe quoi : créer, traduire, explorer…
              </p>
            </div>
            <MessageSquare className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          </div>
        </button>

        {/* Quick actions */}
        <div className="flex gap-1.5 px-4 pb-3.5">
          {ZEUS_ACTIONS.map((a) => (
            <button
              key={a.action}
              onClick={() => openZeus(a.action)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-secondary/60 hover:bg-primary/10 hover:text-primary text-muted-foreground text-[11px] font-medium transition-all duration-200 active:scale-95"
            >
              <a.icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{a.label}</span>
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
