import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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
    <div className="absolute inset-0 z-10 flex pointer-events-none items-center justify-center">
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
  const [optimisticReaction, setOptimisticReaction] = useState<ReactionType | null>(null);
  const { user } = useAuth();
  const navigate = useNavigate();
  const addReaction = useAddReaction();
  const removeReaction = useRemoveReaction();
  const interactionLockRef = useRef(false);

  const activeReaction = currentReaction ?? optimisticReaction;
  const isBusy = addReaction.isPending || removeReaction.isPending || cooldown;

  useEffect(() => {
    if (currentReaction) {
      setOptimisticReaction(null);
    }
  }, [currentReaction]);

  useEffect(() => {
    if (addReaction.isError) {
      interactionLockRef.current = false;
      setCooldown(false);
      setOptimisticReaction(null);
    }
  }, [addReaction.isError]);

  useEffect(() => {
    if (removeReaction.isError) {
      interactionLockRef.current = false;
      setCooldown(false);
    }
  }, [removeReaction.isError]);

  const startCooldown = useCallback(() => {
    setCooldown(true);
    window.setTimeout(() => {
      interactionLockRef.current = false;
      setCooldown(false);
    }, 600);
  }, []);

  const lockInteraction = useCallback(() => {
    interactionLockRef.current = true;
    setIsOpen(false);
    startCooldown();
  }, [startCooldown]);

  const handleReaction = useCallback((reactionType: ReactionType) => {
    if (interactionLockRef.current || isBusy) return;
    if (!user) {
      navigate('/signup', { state: { from: window.location.pathname } });
      return;
    }

    if (activeReaction === reactionType) {
      // Same emoji → remove
      setOptimisticReaction(null);
      lockInteraction();
      haptic('light');
      removeReaction.mutate(postId);
    } else {
      // New or different emoji → add/change
      setOptimisticReaction(reactionType);
      lockInteraction();
      haptic('medium');
      addReaction.mutate({ postId, reactionType });
    }
  }, [user, activeReaction, postId, addReaction, removeReaction, isBusy, lockInteraction]);

  const handleRemoveReaction = useCallback(() => {
    if (interactionLockRef.current || isBusy || !activeReaction) return;
    if (!user) return;

    setOptimisticReaction(null);
    lockInteraction();
    haptic('light');
    removeReaction.mutate(postId);
  }, [user, activeReaction, postId, removeReaction, isBusy, lockInteraction]);

  // Tap always opens picker (to choose or change reaction)
  const handleTriggerClick = useCallback((e?: React.MouseEvent | React.PointerEvent) => {
    if (interactionLockRef.current || isBusy) {
      e?.preventDefault();
      return;
    }
    if (!user) {
      navigate('/signup', { state: { from: window.location.pathname } });
      return;
    }
    setIsOpen(true);
  }, [isBusy, user, navigate]);

  const emojiVariants = {
    hidden: { scale: 0, y: 10 },
    visible: (i: number) => ({
      scale: 1,
      y: 0,
      transition: { delay: i * 0.04, type: 'spring' as const, stiffness: 500, damping: 15 },
    }),
    hover: { scale: 1.4, y: -8, transition: { type: 'spring' as const, stiffness: 400 } },
  };

  const emojiPicker = (
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
            whileHover={!isBusy ? 'hover' : undefined}
            whileTap={!isBusy ? { scale: 0.8 } : undefined}
            onClick={() => handleReaction(type)}
            disabled={isBusy}
            className={cn(
              'group relative rounded-full p-1.5 transition-colors',
              isBusy && 'pointer-events-none opacity-50',
              activeReaction === type && 'bg-accent ring-2 ring-primary/50'
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

  const reactionColor = activeReaction ? REACTION_COLORS[activeReaction] : '';

  if (variant === 'facebook') {
    return (
      <Popover
        open={isOpen}
        onOpenChange={(open) => {
          if (interactionLockRef.current || isBusy) return;
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
                'h-11 w-full gap-1.5 rounded-xl text-xs text-muted-foreground transition-all select-none hover:bg-secondary/50 hover:text-foreground',
                activeReaction && reactionColor,
                isBusy && 'pointer-events-none opacity-60'
              )}
            >
              {activeReaction ? (
                <motion.span
                  key={activeReaction}
                  initial={{ scale: 0, rotate: -30 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 12 }}
                  className="text-lg"
                >
                  {REACTION_EMOJIS[activeReaction]}
                </motion.span>
              ) : (
                <ThumbsUp className="h-[18px] w-[18px]" />
              )}
              <motion.span
                key={activeReaction || 'none'}
                initial={{ y: 5, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="font-semibold"
              >
                {activeReaction ? REACTION_LABELS[activeReaction] : 'Réagir'}
              </motion.span>
            </Button>
          </PopoverTrigger>
        </div>
        {emojiPicker}
      </Popover>
    );
  }

  if (variant === 'instagram') {
    return (
      <Popover
        open={isOpen}
        onOpenChange={(open) => {
          if (interactionLockRef.current || isBusy) return;
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
              {activeReaction ? (
                <motion.span
                  key={activeReaction}
                  initial={{ scale: 0 }}
                  animate={{ scale: [0, 1.3, 1] }}
                  transition={{ type: 'spring', stiffness: 500, damping: 10 }}
                  className="block text-[22px]"
                >
                  {REACTION_EMOJIS[activeReaction]}
                </motion.span>
              ) : (
                <Heart className="h-[22px] w-[22px] text-foreground" />
              )}
            </button>
          </PopoverTrigger>
        </div>
        {emojiPicker}
      </Popover>
    );
  }

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        if (interactionLockRef.current || isBusy) return;
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
              activeReaction && reactionColor,
              isBusy && 'pointer-events-none opacity-60'
            )}
          >
            {activeReaction ? (
              <AnimatePresence mode="wait">
                <motion.span
                  key={activeReaction}
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  exit={{ scale: 0, rotate: 180 }}
                  transition={{ type: 'spring', stiffness: 400 }}
                  className="text-lg"
                >
                  {REACTION_EMOJIS[activeReaction]}
                </motion.span>
              </AnimatePresence>
            ) : (
              <ThumbsUp className="h-4 w-4" />
            )}
            <span className="text-sm">{reactionsCount || ''}</span>
          </Button>
        </PopoverTrigger>
      </div>
      {emojiPicker}
    </Popover>
  );
}
