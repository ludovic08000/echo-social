import { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowLeft, RotateCcw, Bot } from 'lucide-react';
import { AIDifficulty } from './GameLobby';
import { cn } from '@/lib/utils';

interface GameWrapperProps {
  children: ReactNode;
  status: string;
  onReset: () => void;
  onBack: () => void;
  mode: 'ai' | 'local' | 'friend';
  difficulty?: AIDifficulty;
  friendName?: string;
  scores?: ReactNode;
}

const difficultyLabel: Record<AIDifficulty, { label: string; color: string }> = {
  easy: { label: 'Facile', color: 'text-green-400 bg-green-400/10' },
  medium: { label: 'Moyen', color: 'text-yellow-400 bg-yellow-400/10' },
  hard: { label: 'Difficile', color: 'text-red-400 bg-red-400/10' },
};

export default function GameWrapper({ children, status, onReset, onBack, mode, difficulty, friendName, scores }: GameWrapperProps) {
  return (
    <div className="relative rounded-2xl border border-border bg-card/80 backdrop-blur-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 rounded-full">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <div className="text-sm font-bold">{status}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              {mode === 'ai' && difficulty && (
                <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-full flex items-center gap-1', difficultyLabel[difficulty].color)}>
                  <Bot className="w-3 h-3" /> {difficultyLabel[difficulty].label}
                </span>
              )}
              {mode === 'friend' && friendName && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                  vs {friendName}
                </span>
              )}
              {mode === 'local' && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-secondary text-secondary-foreground">
                  2 joueurs
                </span>
              )}
            </div>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onReset} className="h-8 text-xs gap-1.5 rounded-full">
          <RotateCcw className="w-3.5 h-3.5" /> Rejouer
        </Button>
      </div>

      {/* Scores */}
      {scores && (
        <div className="px-4 py-2 border-b border-border/30 bg-muted/30">
          {scores}
        </div>
      )}

      {/* Game area */}
      <div className="p-4">
        {children}
      </div>
    </div>
  );
}
