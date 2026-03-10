import { Zap, MessageSquare } from 'lucide-react';
import { motion } from 'framer-motion';
import { useZeusSettings } from '@/hooks/useZeusCompanion';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { useAuth } from '@/lib/auth';

export function FeedZeusCard() {
  const { user } = useAuth();
  const { zeusName } = useZeusSettings();
  const { openChat } = useChatWidget();

  if (!user) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.15 }}
      className="px-4 mb-3"
    >
      <button
        onClick={() => {
          window.dispatchEvent(new CustomEvent('open-zeus'));
        }}
        className="w-full p-4 rounded-2xl transition-all duration-300 group cursor-pointer relative overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, rgba(0,20,40,0.9) 0%, rgba(0,30,60,0.85) 50%, rgba(0,20,40,0.9) 100%)',
          border: '1px solid rgba(0,255,255,0.15)',
          boxShadow: '0 0 20px rgba(0,255,255,0.05)',
        }}
      >
        {/* Scan line */}
        <motion.div
          animate={{ y: ['-100%', '200%'] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
          className="absolute left-0 right-0 h-8 opacity-[0.06] pointer-events-none"
          style={{ background: 'linear-gradient(180deg, transparent, rgba(0,255,255,0.4), transparent)' }}
        />
        <div className="flex items-center gap-3 relative z-10">
          <div className="w-11 h-11 rounded-full flex items-center justify-center text-cyan-300 relative"
            style={{
              background: 'linear-gradient(135deg, rgba(0,255,255,0.15), rgba(0,100,200,0.15))',
              border: '1px solid rgba(0,255,255,0.25)',
              boxShadow: '0 0 20px rgba(0,255,255,0.15)',
            }}>
            <Zap className="w-5 h-5" />
            <motion.div
              animate={{ opacity: [0.3, 0.7, 0.3] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="absolute inset-0 rounded-full"
              style={{ boxShadow: '0 0 15px rgba(0,255,255,0.3)' }}
            />
          </div>
          <div className="flex-1 text-left">
            <p className="text-sm font-bold font-mono text-cyan-300 tracking-wide">
              {zeusName} <span className="text-cyan-500/40 font-normal text-xs">— IA ASSISTANT</span>
            </p>
            <p className="text-[11px] text-cyan-400/40 mt-0.5 font-mono">
              Publie, gère ton flux, traduis, explore le market ⚡
            </p>
          </div>
          <MessageSquare className="w-5 h-5 text-cyan-500/30 group-hover:text-cyan-400 transition-colors" />
        </div>
      </button>
    </motion.div>
  );
}
