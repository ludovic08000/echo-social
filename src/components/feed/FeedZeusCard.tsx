import { Zap, MessageCircle } from 'lucide-react';
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
          // Open Zeus companion by dispatching a custom event
          window.dispatchEvent(new CustomEvent('open-zeus'));
        }}
        className="w-full p-4 rounded-2xl border border-amber-500/20 bg-gradient-to-r from-amber-500/10 via-orange-500/5 to-amber-500/10 hover:from-amber-500/15 hover:to-amber-500/15 transition-all duration-300 group cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white shadow-lg shadow-amber-500/20 group-hover:shadow-amber-500/30 transition-shadow">
            <Zap className="w-5 h-5" />
          </div>
          <div className="flex-1 text-left">
            <p className="text-sm font-semibold text-foreground">
              {zeusName} <span className="text-muted-foreground font-normal">— ton assistant IA</span>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Parle-moi, demande-moi de poster, ou discutons ! ⚡
            </p>
          </div>
          <MessageCircle className="w-5 h-5 text-amber-500/60 group-hover:text-amber-500 transition-colors" />
        </div>
      </button>
    </motion.div>
  );
}
