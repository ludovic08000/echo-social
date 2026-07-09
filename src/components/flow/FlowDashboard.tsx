import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { MessageCircle, Radio, Bot, Heart, Users, BookOpen, Megaphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUnreadCount } from '@/hooks/useNotifications';
import { useConversations } from '@/hooks/useMessages';

const WIDGETS = [
  { icon: MessageCircle, label: 'Messages', path: '/messages', gradient: 'from-blue-500/20 to-blue-600/10', iconColor: 'text-blue-400', badgeKey: 'messages' },
  { icon: Heart, label: 'Amis', path: '/friends', gradient: 'from-pink-500/20 to-rose-500/10', iconColor: 'text-pink-400' },
  { icon: Radio, label: 'Lives', path: '/live', gradient: 'from-red-500/20 to-red-600/10', iconColor: 'text-red-400' },
  { icon: Users, label: 'Groupes', path: '/groups', gradient: 'from-cyan-500/20 to-cyan-600/10', iconColor: 'text-cyan-400' },
  { icon: Bot, label: 'Zeus IA', path: '#zeus', gradient: 'from-orange-500/20 to-amber-600/10', iconColor: 'text-orange-400' },
  { icon: BookOpen, label: 'Journal', path: '/journal', gradient: 'from-teal-500/20 to-emerald-600/10', iconColor: 'text-teal-400' },
  { icon: Megaphone, label: 'Pub Ads', path: '/ads', gradient: 'from-rose-500/20 to-pink-600/10', iconColor: 'text-rose-400' },
];

export function FlowDashboard() {
  const navigate = useNavigate();
  const { data: unreadCount } = useUnreadCount();
  const { data: conversations } = useConversations();
  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unread_count, 0) || 0;

  const getBadge = (key?: string) => {
    if (key === 'messages') return unreadMessages;
    if (key === 'notifs') return unreadCount;
    return 0;
  };

  const handleClick = (path: string) => {
    if (path === '#zeus') {
      window.dispatchEvent(new Event('open-zeus'));
    } else {
      navigate(path);
    }
  };

  return (
    <div className="px-4 pb-2">
      <div className="grid grid-cols-4 gap-2">
        {WIDGETS.map((w, i) => {
          const badge = getBadge(w.badgeKey);
          return (
            <motion.button
              key={w.path}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.03, type: 'spring', stiffness: 300, damping: 22 }}
              onClick={() => handleClick(w.path)}
              className={cn(
                "relative flex flex-col items-center gap-1.5 py-3 px-1 rounded-2xl border border-border/15 transition-all duration-200",
                "hover:scale-105 hover:shadow-md active:scale-95",
                `bg-gradient-to-br ${w.gradient}`
              )}
            >
              {badge > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center px-1 shadow-sm">
                  {badge > 9 ? '9+' : badge}
                </span>
              )}
              <div className={cn("w-9 h-9 rounded-xl bg-card/60 flex items-center justify-center", w.iconColor)}>
                <w.icon className="w-4.5 h-4.5" />
              </div>
              <span className="text-[10px] font-semibold leading-tight text-center">{w.label}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
