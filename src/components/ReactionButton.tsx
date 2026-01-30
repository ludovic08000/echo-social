import { useState } from 'react';
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
}

export function ReactionButton({ postId, currentReaction, reactionsCount }: ReactionButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { user } = useAuth();
  const addReaction = useAddReaction();
  const removeReaction = useRemoveReaction();

  const handleReaction = (reactionType: ReactionType) => {
    if (!user) {
      toast({
        title: 'Connexion requise',
        description: 'Connectez-vous pour réagir',
        variant: 'destructive',
      });
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
      toast({
        title: 'Connexion requise',
        description: 'Connectez-vous pour réagir',
        variant: 'destructive',
      });
      return;
    }
    
    if (currentReaction) {
      removeReaction.mutate(postId);
    } else {
      addReaction.mutate({ postId, reactionType: 'like' });
    }
  };

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
        className="w-auto p-2 bg-card border border-border shadow-lg"
        sideOffset={5}
      >
        <div className="flex gap-1">
          {(Object.keys(REACTION_EMOJIS) as ReactionType[]).map((type) => (
            <button
              key={type}
              onClick={() => handleReaction(type)}
              className={cn(
                'p-2 rounded-full transition-transform hover:scale-125 hover:bg-accent',
                currentReaction === type && 'bg-accent ring-2 ring-primary'
              )}
              title={REACTION_LABELS[type]}
            >
              <span className="text-2xl">{REACTION_EMOJIS[type]}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
