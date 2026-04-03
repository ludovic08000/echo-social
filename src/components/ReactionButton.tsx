import { useState, useCallback } from 'react';
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

export function ReactionButton({ postId, currentReaction, reactionsCount, variant = 'default' }: ReactionButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { user } = useAuth();
  const addReaction = useAddReaction();
  const removeReaction = useRemoveReaction();

  const handleReaction = useCallback((reactionType: ReactionType) => {
    if (!user) {
      toast({ title: 'Connexion requise', description: 'Connectez-vous pour réagir', variant: 'destructive' });
      return;
    }
    if (currentReaction === reactionType) {
      removeReaction.mutate(postId);
    } else {
      addReaction.mutate({ postId, reactionType });
    }
    setIsOpen(false);
  }, [user, currentReaction, postId, addReaction, removeReaction]);

  const handleQuickLike = useCallback(() => {
    if (!user) {
      toast({ title: 'Connexion requise', description: 'Connectez-vous pour réagir', variant: 'destructive' });
      return;
    }
    if (currentReaction) {
      removeReaction.mutate(postId);
    } else {
      addReaction.mutate({ postId, reactionType: 'like' });
    }
  }, [user, currentReaction, postId, addReaction, removeReaction]);

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
      className="w-auto p-1.5 bg-card border-border/30 shadow-xl rounded-full"
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
            onClick={() => handleReaction(type)}
            className={cn(
              'p-1.5 rounded-full transition-colors',
              currentReaction === type && 'bg-accent ring-2 ring-primary/50'
            )}
            title={REACTION_LABELS[type]}
          >
            <span className="text-[22px] block">{REACTION_EMOJIS[type]}</span>
          </motion.button>
        ))}
      </div>
    </PopoverContent>
  );

  // Instagram variant — heart icon, double tap feel
  if (variant === 'instagram') {
    return (
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex items-center">
          <button
            onClick={handleQuickLike}
            className="h-10 w-10 flex items-center justify-center transition-transform active:scale-75"
          >
            {currentReaction ? (
              <motion.span
                key={currentReaction}
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
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

  if (variant === 'facebook') {
    return (
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex-1 flex">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'flex-1 h-11 gap-1 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl text-xs transition-all',
              currentReaction && 'text-primary'
            )}
            onClick={handleQuickLike}
          >
            {currentReaction ? (
              <span className="text-lg">{REACTION_EMOJIS[currentReaction]}</span>
            ) : (
              <ThumbsUp className="w-[18px] h-[18px]" />
            )}
            <span className="font-medium">
              {currentReaction ? REACTION_LABELS[currentReaction] : "J'aime"}
            </span>
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

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-9 px-3 gap-2 text-muted-foreground hover:text-primary hover:bg-accent',
            currentReaction && 'text-primary'
          )}
          onClick={handleQuickLike}
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
