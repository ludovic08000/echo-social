import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Heart, ThumbsUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useAddReaction, REACTION_EMOJIS, REACTION_LABELS, ReactionType } from '@/hooks/useReactions';
import { useAuth } from '@/lib/auth';

interface ReactionButtonProps {
  postId: string;
  currentReaction?: ReactionType | null;
  reactionsCount: number;
  variant?: 'default' | 'facebook' | 'instagram';
}

function haptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  try {
    if ('vibrate' in navigator) {
      navigator.vibrate(style === 'heavy' ? 30 : style === 'medium' ? 15 : 8);
    }
  } catch {
    // Haptic feedback is optional and unsupported browsers may reject it.
  }
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
  const [selectedReaction, setSelectedReaction] = useState<ReactionType | null>(currentReaction ?? null);
  const { user } = useAuth();
  const navigate = useNavigate();
  const addReaction = useAddReaction();
  const interactionLockRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const activeReaction = selectedReaction;
  const isBusy = addReaction.isPending || interactionLockRef.current;

  useEffect(() => {
    if (!interactionLockRef.current) setSelectedReaction(currentReaction ?? null);
  }, [currentReaction]);

  useEffect(() => {
    if (!isOpen) return;

    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [isOpen]);

  const handleReaction = useCallback((reactionType: ReactionType) => {
    if (interactionLockRef.current || isBusy) return;
    if (!user) {
      navigate('/signup', { state: { from: window.location.pathname } });
      return;
    }

    if (activeReaction === reactionType) {
      setIsOpen(false);
      return;
    }

    const previousReaction = activeReaction;
    interactionLockRef.current = true;
    setSelectedReaction(reactionType);
    setIsOpen(false);
    haptic('medium');
    addReaction.mutate(
      { postId, reactionType, previousReaction },
      {
        onError: () => setSelectedReaction(previousReaction),
        onSettled: () => {
          interactionLockRef.current = false;
        },
      },
    );
  }, [user, activeReaction, postId, addReaction, isBusy, navigate]);

  // Le bouton ne crée jamais une réaction : il ouvre seulement le choix.
  // Une réaction déjà choisie reste verrouillée jusqu'à son remplacement.
  const handleTriggerClick = useCallback((e?: React.MouseEvent | React.PointerEvent) => {
    if (interactionLockRef.current || isBusy) {
      e?.preventDefault();
      return;
    }
    if (!user) {
      navigate('/signup', { state: { from: window.location.pathname } });
      return;
    }
    setIsOpen((open) => !open);
  }, [isBusy, user, navigate]);

  const emojiPicker = isOpen ? (
    <motion.div
      role="menu"
      aria-label="Choisir une réaction"
      initial={{ opacity: 0, y: 6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.96 }}
      className="absolute bottom-full left-1/2 z-50 mb-2 flex -translate-x-1/2 gap-1 rounded-full border border-border bg-popover p-1.5 shadow-2xl"
    >
        {(Object.keys(REACTION_EMOJIS) as ReactionType[]).map((type) => (
          <Button
            key={type}
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => handleReaction(type)}
            disabled={isBusy || activeReaction === type}
            className={cn(
              'group relative h-10 w-10 shrink-0 rounded-full p-0 text-[26px] transition-transform hover:-translate-y-1 hover:bg-accent',
              isBusy && 'pointer-events-none opacity-50',
              activeReaction === type && 'bg-accent ring-2 ring-primary/50'
            )}
            title={REACTION_LABELS[type]}
            aria-label={REACTION_LABELS[type]}
            aria-checked={activeReaction === type}
            role="menuitemradio"
          >
            {REACTION_EMOJIS[type]}
          </Button>
        ))}
    </motion.div>
  ) : null;

  const reactionColor = activeReaction ? REACTION_COLORS[activeReaction] : '';

  if (variant === 'facebook') {
    return (
        <div ref={rootRef} className="relative flex-1">
          <AnimatePresence>{emojiPicker}</AnimatePresence>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleTriggerClick}
              disabled={isBusy}
              aria-expanded={isOpen}
              aria-haspopup="menu"
              aria-pressed={Boolean(activeReaction)}
              aria-label={activeReaction
                ? `Réaction actuelle : ${REACTION_LABELS[activeReaction]}. Cliquer pour modifier`
                : 'Ajouter une réaction'}
              className={cn(
                'h-11 w-full gap-1.5 rounded-xl text-xs text-muted-foreground transition-all select-none hover:bg-secondary/50 hover:text-foreground',
                activeReaction && reactionColor,
                isBusy && 'pointer-events-none opacity-60'
              )}
            >
              {activeReaction ? (
                <motion.span
                  key={`emoji-${activeReaction}`}
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
                key={`label-${activeReaction || 'none'}`}
                initial={{ y: 5, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="font-semibold"
              >
                {activeReaction ? REACTION_LABELS[activeReaction] : 'Réagir'}
              </motion.span>
            </Button>
        </div>
    );
  }

  if (variant === 'instagram') {
    return (
        <div ref={rootRef} className="relative flex items-center">
          <AnimatePresence>{emojiPicker}</AnimatePresence>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleTriggerClick}
              disabled={isBusy}
              aria-expanded={isOpen}
              aria-haspopup="menu"
              aria-pressed={Boolean(activeReaction)}
              aria-label={activeReaction
                ? `Réaction actuelle : ${REACTION_LABELS[activeReaction]}. Cliquer pour modifier`
                : 'Ajouter une réaction'}
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
            </Button>
        </div>
    );
  }

  return (
      <div ref={rootRef} className="relative flex items-center">
        <AnimatePresence>{emojiPicker}</AnimatePresence>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleTriggerClick}
            disabled={isBusy}
            aria-expanded={isOpen}
            aria-haspopup="menu"
            aria-pressed={Boolean(activeReaction)}
            aria-label={activeReaction
              ? `Réaction actuelle : ${REACTION_LABELS[activeReaction]}. Cliquer pour modifier`
              : 'Ajouter une réaction'}
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
      </div>
  );
}
