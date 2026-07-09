import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X, MessageCircle, Radio, Bot, Heart, Users, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';

const MENU_ITEMS = [
  { icon: MessageCircle, label: 'Messages', path: '/messages', color: 'from-blue-400 to-blue-600' },
  { icon: Heart, label: 'Amis', path: '/friends', color: 'from-pink-400 to-rose-500' },
  { icon: Radio, label: 'Live', path: '/live', color: 'from-red-400 to-red-600' },
  { icon: Bot, label: 'Zeus', path: '#zeus', color: 'from-amber-400 to-orange-500' },
  { icon: Users, label: 'Groupes', path: '/groups', color: 'from-cyan-400 to-cyan-600' },
  { icon: Settings, label: 'Réglages', path: '/settings', color: 'from-gray-400 to-gray-600' },
];

export function FlowRadialMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const handleSelect = (path: string) => {
    setOpen(false);
    if (path === '#zeus') {
      window.dispatchEvent(new Event('open-zeus'));
    } else {
      navigate(path);
    }
  };

  // Position items in a semi-circle above the button
  const getPosition = (index: number, total: number) => {
    const angleStart = -170; // degrees
    const angleEnd = -10;
    const angle = angleStart + (angleEnd - angleStart) * (index / (total - 1));
    const rad = (angle * Math.PI) / 180;
    const radius = 130;
    return {
      x: Math.cos(rad) * radius,
      y: Math.sin(rad) * radius,
    };
  };

  return (
    <>
      {/* Backdrop */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-background/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Menu items */}
      <div className="fixed bottom-24 right-5 z-[71]">
        <AnimatePresence>
          {open && MENU_ITEMS.map((item, i) => {
            const pos = getPosition(i, MENU_ITEMS.length);
            return (
              <motion.button
                key={item.path}
                initial={{ opacity: 0, x: 0, y: 0, scale: 0 }}
                animate={{ opacity: 1, x: pos.x, y: pos.y, scale: 1 }}
                exit={{ opacity: 0, x: 0, y: 0, scale: 0 }}
                transition={{ delay: i * 0.04, type: 'spring', stiffness: 300, damping: 20 }}
                className="absolute flex flex-col items-center gap-1"
                onClick={() => handleSelect(item.path)}
              >
                <div className={cn(
                  "w-12 h-12 rounded-2xl bg-gradient-to-br flex items-center justify-center shadow-lg",
                  item.color
                )}>
                  <item.icon className="w-5 h-5 text-white" />
                </div>
                <span className="text-[10px] font-semibold text-foreground bg-card/90 px-2 py-0.5 rounded-full shadow-sm whitespace-nowrap">
                  {item.label}
                </span>
              </motion.button>
            );
          })}
        </AnimatePresence>

        {/* FAB */}
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={() => setOpen(!open)}
          className={cn(
            "w-14 h-14 rounded-full flex items-center justify-center shadow-xl transition-colors duration-300",
            open
              ? "bg-muted text-foreground"
              : "bg-[image:var(--premium-gradient)] text-primary-foreground"
          )}
          style={{ boxShadow: open ? undefined : 'var(--shadow-glow)' }}
        >
          {open ? <X className="w-6 h-6" /> : <Sparkles className="w-6 h-6" />}
        </motion.button>
      </div>
    </>
  );
}
