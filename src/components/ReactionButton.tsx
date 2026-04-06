import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
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

function haptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  try {
    if ('vibrate' in navigator) {
      navigator.vibrate(style === 'heavy' ? 30 : style === 'medium' ? 15 : 8);
    }
  } catch {}
}

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
  const [cooldown, setCooldown] = useState(false);
  const { user } = useAuth();
  const addReaction = useAddReaction();
  const removeReaction = useRemoveReaction();
  const interactionLockRef = useRef(false);
  const isBusy = addReaction.isPending || removeReaction.isPending || cooldown;

  const startCooldown = useCallback(() => {
    setCooldown(true);
    window.setTimeout(() => {
      interactionLockRef.current = false;
      setCooldown(false);
    }, 1200);
  }, []);

  const lockInteraction = useCallback(() => {
    interactionLockRef.current = true;
    setIsOpen(false);
    startCooldown();
  }, [startCooldown]);

  const handleReaction = useCallback((reactionType: ReactionType) => {
    if (interactionLockRef.current || isBusy || currentReaction) return;
    if (!user) {
      toast({ title: 'Connexion requise', description: 'Connectez-vous pour réagir', variant: 'destructive' });
      return;
    }

    lockInteraction();
    haptic('medium');
    setShowParticles(REACTION_EMOJIS[reactionType]);
    addReaction.mutate({ postId, reactionType });
  }, [user, currentReaction, postId, addReaction, isBusy, lockInteraction]);

  const handleRemoveReaction = useCallback(() => {
    if (interactionLockRef.current || isBusy || !currentReaction) return;
    if (!user) return;

    lockInteraction();
    haptic('light');
    removeReaction.mutate(postId);
  }, [user, currentReaction, postId, removeReaction, isBusy, lockInteraction]);

  const handleTriggerClick = useCallback((e?: React.MouseEvent | React.PointerEvent) => {
    if (interactionLockRef.current || isBusy) {
      e?.preventDefault();
      return;
    }

    if (currentReaction) {
      e?.preventDefault();
      handleRemoveReaction();
      return;
    }

    setIsOpen(true);
  }, [currentReaction, handleRemoveReaction, isBusy]);

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
      className="w-auto rounded-full border-border/30 bg-card/95 p-1.5 shadow-2xl backdrop-blur-xl"
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
            whileHover={!currentReaction && !isBusy ? 'hover' : undefined}
            whileTap={!currentReaction && !isBusy ? { scale: 0.8 } : undefined}
            onClick={() => handleReaction(type)}
            disabled={!!currentReaction || isBusy}
            className={cn(
              'relative rounded-full p-1.5 transition-colors group',
              (currentReaction || isBusy) && 'pointer-events-none opacity-50',
              currentReaction === type && 'bg-accent ring-2 ring-primary/50'
            )}
            title={REACTION_LABELS[type]}
          >
            <span className="block text-[26px] drop-shadow-sm">{REACTION_EMOJIS[type]}</span>
            <span className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-foreground/90 px-2 py-0.5 text-[10px] font-semibold text-background opacity-0 transition-opacity group-hover:opacity-100">
              {REACTION_LABELS[type]}
            </span>
          </motion.button>
        ))}
      </div>
    </PopoverContent>
  );

  const reactionColor = currentReaction ? REACTION_COLORS[currentReaction] : '';

  if (variant === 'facebook') {
    return (
      <Popover
        open={isOpen}
        onOpenChange={(open) => {
          if (interactionLockRef.current || isBusy || currentReaction) return;
          setIsOpen(open);
        }}
      >
        <div className="relative flex-1">
          <AnimatePresence>
            {showParticles && (
              <ReactionParticles emoji={showParticles} onDone={() => setShowParticles(null)} />
            )}
          </AnimatePresence>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleTriggerClick}
              className={cn(
                'w-full h-11 gap-1.5 rounded-xl text-xs text-muted-foreground transition-all select-none hover:bg-secondary/50 hover:text-foreground',
                currentReaction && reactionColor,
                isBusy && 'pointer-events-none opacity-60'
              )}
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
                <ThumbsUp className="h-[18px] w-[18px]" />
              )}
              <motion.span
                key={currentReaction || 'none'}
                initial={{ y: 5, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="font-semibold"
              >
                {currentReaction ? REACTION_LABELS[currentReaction] : 'Réagir'}
              </motion.span>
            </Button>
          </PopoverTrigger>
        </div>
        {EmojiPicker}
      </Popover>
    );
  }

  if (variant === 'instagram') {
    return (
      <Popover
        open={isOpen}
        onOpenChange={(open) => {
          if (interactionLockRef.current || isBusy || currentReaction) return;
          setIsOpen(open);
        }}
      >
        <div className="relative flex items-center">
          <AnimatePresence>
            {showParticles && (
              <ReactionParticles emoji={showParticles} onDone={() => setShowParticles(null)} />
            )}
          </AnimatePresence>
          <PopoverTrigger asChild>
            <button
              onClick={handleTriggerClick}
              className={cn(
                'flex h-10 w-10 items-center justify-center select-none transition-transform active:scale-75',
                isBusy && 'pointer-events-none opacity-60'
              )}
            >
              {currentReaction ? (
                <motion.span
                  key={currentReaction}
                  initial={{ scale: 0 }}
                  animate={{ scale: [0, 1.3, 1] }}
                  transition={{ type: 'spring', stiffness: 500, damping: 10 }}
                  className="block text-[22px]"
                >
                  {REACTION_EMOJIS[currentReaction]}
                </motion.span>
              ) : (
                <Heart className="h-[22px] w-[22px] text-foreground" />
              )}
            </button>
          </PopoverTrigger>
        </div>
        {EmojiPicker}
      </Popover>
    );
  }

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        if (interactionLockRef.current || isBusy || currentReaction) return;
        setIsOpen(open);
      }}
    >
      <div className="relative flex items-center">
        <AnimatePresence>
          {showParticles && (
            <ReactionParticles emoji={showParticles} onDone={() => setShowParticles(null)} />
          )}
        </AnimatePresence>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleTriggerClick}
            className={cn(
              'h-9 gap-2 px-3 text-muted-foreground hover:bg-accent hover:text-primary',
              currentReaction && reactionColor,
              isBusy && 'pointer-events-none opacity-60'
            )}
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
              <ThumbsUp className="h-4 w-4" />
            )}
            <span className="text-sm">{reactionsCount || ''}</span>
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
