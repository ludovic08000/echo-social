import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ThumbsUp } from 'lucide-react';
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
import { useIsMobile } from '@/hooks/use-mobile';

interface ReactionButtonProps {
  postId: string;
  currentReaction?: ReactionType | null;
  reactionsCount: number;
  variant?: 'default' | 'facebook';
}

export function ReactionButton({ postId, currentReaction, reactionsCount, variant = 'default' }: ReactionButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { user } = useAuth();
  const addReaction = useAddReaction();
  const removeReaction = useRemoveReaction();

  const handleReaction = (reactionType: ReactionType) => {
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
  };

  const handleQuickLike = () => {
    if (!user) {
      toast({ title: 'Connexion requise', description: 'Connectez-vous pour réagir', variant: 'destructive' });
      return;
    }
    if (currentReaction) {
      removeReaction.mutate(postId);
    } else {
      addReaction.mutate({ postId, reactionType: 'like' });
    }
  };

  const emojiVariants = {
    hidden: { scale: 0, y: 10 },
    visible: (i: number) => ({
      scale: 1,
      y: 0,
      transition: { delay: i * 0.04, type: 'spring' as const, stiffness: 500, damping: 15 },
    }),
    hover: { scale: 1.4, y: -8, transition: { type: 'spring' as const, stiffness: 400 } },
  };

  if (variant === 'facebook') {
    return (
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <motion.div className="flex-1" whileTap={{ scale: 0.95 }}>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'w-full h-11 gap-2 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl text-xs transition-all',
                currentReaction && 'text-primary'
              )}
              onDoubleClick={handleQuickLike}
            >
              <AnimatePresence mode="wait">
                {currentReaction ? (
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
                ) : (
                  <motion.div key="default" initial={{ scale: 0 }} animate={{ scale: 1 }}>
                    <ThumbsUp className="w-[18px] h-[18px]" />
                  </motion.div>
                )}
              </AnimatePresence>
              <span className="font-medium">
                {currentReaction ? REACTION_LABELS[currentReaction] : "J'aime"}
              </span>
            </Button>
          </motion.div>
        </PopoverTrigger>
        
        <PopoverContent 
          side="top" 
          className="w-auto p-2 glass border-border/30 shadow-premium-lg rounded-full"
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
                  'p-2 rounded-full transition-colors',
                  currentReaction === type && 'bg-accent ring-2 ring-primary/50'
                )}
                title={REACTION_LABELS[type]}
              >
                <span className="text-2xl block">{REACTION_EMOJIS[type]}</span>
              </motion.button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <div className="flex items-center">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-9 px-3 gap-2 text-muted-foreground hover:text-primary hover:bg-accent',
              currentReaction && 'text-primary'
            )}
            onDoubleClick={handleQuickLike}
          >
            {currentReaction ? (
              <span className="text-lg">{REACTION_EMOJIS[currentReaction]}</span>
            ) : (
              <ThumbsUp className="w-4 h-4" />
            )}
            <span className="text-sm">{reactionsCount || ''}</span>
          </Button>
        </PopoverTrigger>
      </div>
      
      <PopoverContent 
        side="top" 
        className="w-auto p-2 glass border-border/30 shadow-premium-lg rounded-full"
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
                'p-2 rounded-full transition-colors',
                currentReaction === type && 'bg-accent ring-2 ring-primary/50'
              )}
              title={REACTION_LABELS[type]}
            >
              <span className="text-2xl block">{REACTION_EMOJIS[type]}</span>
            </motion.button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
