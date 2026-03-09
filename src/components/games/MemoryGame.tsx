import { useState, useEffect, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { RotateCcw, Trophy } from 'lucide-react';

const EMOJIS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🦁', '🐵', '🐰', '🐻', '🦄', '🐝', '🦋'];

type Card = { id: number; emoji: string; flipped: boolean; matched: boolean };

function shuffleCards(pairCount: number): Card[] {
  const selected = EMOJIS.slice(0, pairCount);
  const pairs = [...selected, ...selected];
  const shuffled = pairs.sort(() => Math.random() - 0.5);
  return shuffled.map((emoji, i) => ({ id: i, emoji, flipped: false, matched: false }));
}

const MemoryGame = forwardRef<HTMLDivElement>((_, ref) => {
  const [difficulty, setDifficulty] = useState<4 | 6 | 8>(6);
  const [cards, setCards] = useState(() => shuffleCards(difficulty));
  const [selected, setSelected] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const [matchedCount, setMatchedCount] = useState(0);
  const [locked, setLocked] = useState(false);
  const [bestScore, setBestScore] = useState<number | null>(null);
  const [timer, setTimer] = useState(0);
  const [started, setStarted] = useState(false);

  const totalPairs = difficulty;
  const won = matchedCount >= totalPairs;
  const cols = difficulty <= 4 ? 4 : difficulty <= 6 ? 4 : 4;

  useEffect(() => {
    if (!started || won) return;
    const interval = setInterval(() => setTimer(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [started, won]);

  useEffect(() => {
    if (won && (bestScore === null || moves < bestScore)) {
      setBestScore(moves);
    }
  }, [won, moves, bestScore]);

  const handleClick = (index: number) => {
    if (locked || cards[index].flipped || cards[index].matched) return;
    if (!started) setStarted(true);

    const newCards = [...cards];
    newCards[index] = { ...newCards[index], flipped: true };
    const newSelected = [...selected, index];
    setCards(newCards);
    setSelected(newSelected);

    if (newSelected.length === 2) {
      setMoves(m => m + 1);
      setLocked(true);
      const [first, second] = newSelected;

      if (newCards[first].emoji === newCards[second].emoji) {
        setTimeout(() => {
          const matched = newCards.map((c, i) =>
            i === first || i === second ? { ...c, matched: true } : c
          );
          setCards(matched);
          setMatchedCount(mc => mc + 1);
          setSelected([]);
          setLocked(false);
        }, 400);
      } else {
        setTimeout(() => {
          const reset = newCards.map((c, i) =>
            i === first || i === second ? { ...c, flipped: false } : c
          );
          setCards(reset);
          setSelected([]);
          setLocked(false);
        }, 800);
      }
    }
  };

  const restart = (newDiff?: 4 | 6 | 8) => {
    const d = newDiff || difficulty;
    setDifficulty(d);
    setCards(shuffleCards(d));
    setSelected([]);
    setMoves(0);
    setMatchedCount(0);
    setLocked(false);
    setTimer(0);
    setStarted(false);
  };

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  return (
    <div ref={ref} className="flex flex-col items-center gap-4 py-4">
      <div className="text-center">
        <div className="text-4xl mb-2">🧠</div>
        <h2 className="text-lg font-bold">Memory</h2>
        {won ? (
          <p className="text-sm text-green-400 font-bold mt-1 flex items-center justify-center gap-1">
            <Trophy className="w-4 h-4" /> Bravo ! {moves} coups en {formatTime(timer)}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">
            {moves} coups • {formatTime(timer)} • {matchedCount}/{totalPairs} paires
          </p>
        )}
      </div>

      {!started && (
        <div className="flex gap-2">
          {([4, 6, 8] as const).map(d => (
            <Button
              key={d}
              size="sm"
              variant={difficulty === d ? 'default' : 'outline'}
              onClick={() => restart(d)}
            >
              {d === 4 ? 'Facile' : d === 6 ? 'Normal' : 'Difficile'}
            </Button>
          ))}
        </div>
      )}

      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {cards.map((card, i) => (
          <button
            key={card.id}
            onClick={() => handleClick(i)}
            className={cn(
              'w-16 h-16 sm:w-18 sm:h-18 rounded-xl text-2xl font-bold transition-all duration-300 transform',
              card.matched && 'bg-green-500/20 scale-95 border-green-500/50',
              card.flipped && !card.matched && 'bg-primary/20 border-primary/50 rotate-0',
              !card.flipped && !card.matched && 'bg-muted/60 hover:bg-muted border-border hover:scale-105 cursor-pointer',
              'border-2 flex items-center justify-center'
            )}
          >
            {card.flipped || card.matched ? (
              <span className="animate-in zoom-in-50 duration-200">{card.emoji}</span>
            ) : (
              <span className="text-muted-foreground text-lg">?</span>
            )}
          </button>
        ))}
      </div>

      {(won || started) && (
        <Button onClick={() => restart()} size="sm" variant="outline" className="mt-2">
          <RotateCcw className="w-4 h-4 mr-2" /> {won ? 'Rejouer' : 'Recommencer'}
        </Button>
      )}

      {bestScore !== null && (
        <p className="text-xs text-muted-foreground">
          🏆 Meilleur score : {bestScore} coups
        </p>
      )}
    </div>
  );
});

MemoryGame.displayName = 'MemoryGame';
export default MemoryGame;