import { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence, useAnimation } from 'framer-motion';
import { Heart, ThumbsUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useAddReaction, useRemoveReaction, REACTION_EMOJIS, REACTION_LABELS, ReactionType } from '@/hooks/useReactions';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';

interface ReactionButtonProps {
  postId: string;
  currentReaction?: ReactionType | null;
  reactionsCount: number;
  variant?: 'default' | 'facebook' | 'instagram';
}

// ── Particle burst effect ────────────────────────────
function ReactionParticles({ emoji, onDone }: { emoji: string; onDone: () => void }) {
  const particles = Array.from({ length: 6 }, (_, i) => {
    const angle = (i / 6) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const distance = 30 + Math.random() * 25;
    return {
      id: i,
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
      rotate: Math.random() * 360,
      scale: 0.5 + Math.random() * 0.6,
      delay: i * 0.03,
    };
  });

  useEffect(() => {
    const t = setTimeout(onDone, 700);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="absolute inset-0 pointer-events-none z-10 flex items-center justify-center">
      {particles.map((p) => (
        <motion.span
          key={p.id}
          className="absolute text-sm"
          initial={{ x: 0, y: 0, scale: 0, opacity: 1, rotate: 0 }}
          animate={{
            x: p.x,
            y: p.y,
            scale: [0, p.scale, 0],
            opacity: [0, 1, 0],
            rotate: p.rotate,
          }}
          transition={{ duration: 0.6, delay: p.delay, ease: 'easeOut' }}
        >
          {emoji}
        </motion.span>
      ))}
    </div>
  );
}

// ── Haptic helper ────────────────────────────────────
function haptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  try {
    if ('vibrate' in navigator) {
      navigator.vibrate(style === 'heavy' ? 30 : style === 'medium' ? 15 : 8);
    }
  } catch {}
}

// ── Color map for each reaction ──────────────────────
const REACTION_COLORS: Record<ReactionType, string> = {
  like: 'text-blue-500',
  love: 'text-red-500',
  haha: 'text-amber-500',
  wow: 'text-amber-500',
  sad: 'text-amber-600',
  angry: 'text-orange-600',
};

export function ReactionButton({ postId, currentReaction, reactionsCount, variant = 'default' }: ReactionButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showParticles, setShowParticles] = useState<string | null>(null);
  const { user } = useAuth();
  const addReaction = useAddReaction();
  const removeReaction = useRemoveReaction();
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  const cooldownRef = useRef(false);
  const isBusy = addReaction.isPending || removeReaction.isPending || cooldownRef.current;

  const startCooldown = useCallback(() => {
    cooldownRef.current = true;
    setTimeout(() => { cooldownRef.current = false; }, 800);
  }, []);

  const handleReaction = useCallback((reactionType: ReactionType) => {
    if (isBusy) return;
    if (!user) {
      toast({ title: 'Connexion requise', description: 'Connectez-vous pour réagir', variant: 'destructive' });
      return;
    }
    haptic('medium');
    setShowParticles(REACTION_EMOJIS[reactionType]);
    if (currentReaction === reactionType) {
      removeReaction.mutate(postId);
    } else {
      addReaction.mutate({ postId, reactionType });
    }
    setIsOpen(false);
  }, [user, currentReaction, postId, addReaction, removeReaction, isBusy]);

  const handleQuickLike = useCallback(() => {
    if (isBusy) return;
    if (!user) {
      toast({ title: 'Connexion requise', description: 'Connectez-vous pour réagir', variant: 'destructive' });
      return;
    }
    haptic('light');
    if (currentReaction) {
      removeReaction.mutate(postId);
    } else {
      setShowParticles('👍');
      addReaction.mutate({ postId, reactionType: 'like' });
    }
  }, [user, currentReaction, postId, addReaction, removeReaction, isBusy]);

  // Long press to open picker (mobile-friendly)
  const onPointerDown = useCallback(() => {
    didLongPress.current = false;
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      haptic('heavy');
      setIsOpen(true);
    }, 500);
  }, []);

  const onPointerUp = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (!didLongPress.current) {
      handleQuickLike();
    }
  }, [handleQuickLike]);

  const onPointerLeave = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const emojiVariants = {
    hidden: { scale: 0, y: 10 },
    visible: (i: number) => ({
      scale: 1,
      y: 0,
      transition: { delay: i * 0.04, type: 'spring' as const, stiffness: 500, damping: 15 },
    }),
    hover: { scale: 1.4, y: -8, transition: { type: 'spring' as const, stiffness: 400 } },
  };

  const EmojiPicker = (
    <PopoverContent 
      side="top" 
      className="w-auto p-1.5 bg-card/95 backdrop-blur-xl border-border/30 shadow-2xl rounded-full"
      sideOffset={8}
    >
      <div className="flex gap-0.5">
        {(Object.keys(REACTION_EMOJIS) as ReactionType[]).map((type, i) => (
          <motion.button
            key={type}
            custom={i}
            variants={emojiVariants}
            initial="hidden"
            animate="visible"
            whileHover="hover"
            whileTap={{ scale: 0.8 }}
            onClick={() => handleReaction(type)}
            className={cn(
              'p-1.5 rounded-full transition-colors relative group',
              currentReaction === type && 'bg-accent ring-2 ring-primary/50'
            )}
            title={REACTION_LABELS[type]}
          >
            <span className="text-[26px] block drop-shadow-sm">{REACTION_EMOJIS[type]}</span>
            {/* Label tooltip */}
            <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-foreground/90 text-background text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              {REACTION_LABELS[type]}
            </span>
          </motion.button>
        ))}
      </div>
    </PopoverContent>
  );

  const reactionColor = currentReaction ? REACTION_COLORS[currentReaction] : '';

  // ── Facebook variant ───────────────────────────────
  if (variant === 'facebook') {
    return (
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex-1 flex relative">
          <AnimatePresence>
            {showParticles && (
              <ReactionParticles emoji={showParticles} onDone={() => setShowParticles(null)} />
            )}
          </AnimatePresence>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'flex-1 h-11 gap-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl text-xs transition-all select-none',
              currentReaction && reactionColor
            )}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerLeave}
            onContextMenu={(e) => e.preventDefault()}
          >
            {currentReaction ? (
              <motion.span
                key={currentReaction}
                initial={{ scale: 0, rotate: -30 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 12 }}
                className="text-lg"
              >
                {REACTION_EMOJIS[currentReaction]}
              </motion.span>
            ) : (
              <ThumbsUp className="w-[18px] h-[18px]" />
            )}
            <motion.span
              key={currentReaction || 'none'}
              initial={{ y: 5, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="font-semibold"
            >
              {currentReaction ? REACTION_LABELS[currentReaction] : "J'aime"}
            </motion.span>
          </Button>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-11 w-9 px-0 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl"
            >
              <ChevronIcon />
            </Button>
          </PopoverTrigger>
        </div>
        {EmojiPicker}
      </Popover>
    );
  }

  // ── Instagram variant ──────────────────────────────
  if (variant === 'instagram') {
    return (
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex items-center relative">
          <AnimatePresence>
            {showParticles && (
              <ReactionParticles emoji={showParticles} onDone={() => setShowParticles(null)} />
            )}
          </AnimatePresence>
          <button
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerLeave}
            onContextMenu={(e) => e.preventDefault()}
            className="h-10 w-10 flex items-center justify-center transition-transform active:scale-75 select-none"
          >
            {currentReaction ? (
              <motion.span
                key={currentReaction}
                initial={{ scale: 0 }}
                animate={{ scale: [0, 1.3, 1] }}
                transition={{ type: 'spring', stiffness: 500, damping: 10 }}
                className="text-[22px] block"
              >
                {REACTION_EMOJIS[currentReaction]}
              </motion.span>
            ) : (
              <Heart className="w-[22px] h-[22px] text-foreground" />
            )}
          </button>
          <PopoverTrigger asChild>
            <button className="h-8 w-5 flex items-center justify-center text-muted-foreground">
              <ChevronIcon />
            </button>
          </PopoverTrigger>
        </div>
        {EmojiPicker}
      </Popover>
    );
  }

  // ── Default variant ────────────────────────────────
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <div className="flex items-center relative">
        <AnimatePresence>
          {showParticles && (
            <ReactionParticles emoji={showParticles} onDone={() => setShowParticles(null)} />
          )}
        </AnimatePresence>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-9 px-3 gap-2 text-muted-foreground hover:text-primary hover:bg-accent',
            currentReaction && reactionColor
          )}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onContextMenu={(e) => e.preventDefault()}
        >
          {currentReaction ? (
            <AnimatePresence mode="wait">
              <motion.span
                key={currentReaction}
                initial={{ scale: 0, rotate: -180 }}
                animate={{ scale: 1, rotate: 0 }}
                exit={{ scale: 0, rotate: 180 }}
                transition={{ type: 'spring', stiffness: 400 }}
                className="text-lg"
              >
                {REACTION_EMOJIS[currentReaction]}
              </motion.span>
            </AnimatePresence>
          ) : (
            <ThumbsUp className="w-4 h-4" />
          )}
          <span className="text-sm">{reactionsCount || ''}</span>
        </Button>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-9 w-7 px-0">
            <ChevronIcon />
          </Button>
        </PopoverTrigger>
      </div>
      {EmojiPicker}
    </Popover>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="opacity-40">
      <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
