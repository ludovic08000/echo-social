import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { RotateCcw } from 'lucide-react';

type Cell = 'X' | 'O' | null;

const WINNING_LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
];

function checkWinner(cells: Cell[]): { winner: Cell; line: number[] } | null {
  for (const line of WINNING_LINES) {
    const [a,b,c] = line;
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) {
      return { winner: cells[a], line };
    }
  }
  return null;
}

export default function TicTacToeGame() {
  const [cells, setCells] = useState<Cell[]>(Array(9).fill(null));
  const [isXTurn, setIsXTurn] = useState(true);
  const [scores, setScores] = useState({ X: 0, O: 0, draws: 0 });

  const result = checkWinner(cells);
  const isDraw = !result && cells.every(c => c !== null);

  const reset = useCallback(() => {
    setCells(Array(9).fill(null));
    setIsXTurn(true);
  }, []);

  const fullReset = useCallback(() => {
    reset();
    setScores({ X: 0, O: 0, draws: 0 });
  }, [reset]);

  const handleClick = (index: number) => {
    if (cells[index] || result) return;
    const newCells = [...cells];
    newCells[index] = isXTurn ? 'X' : 'O';
    setCells(newCells);

    const newResult = checkWinner(newCells);
    if (newResult) {
      setScores(prev => ({ ...prev, [newResult.winner!]: prev[newResult.winner!] + 1 }));
    } else if (newCells.every(c => c !== null)) {
      setScores(prev => ({ ...prev, draws: prev.draws + 1 }));
    }
    setIsXTurn(!isXTurn);
  };

  const statusText = result
    ? `🏆 ${result.winner} gagne !`
    : isDraw
    ? '🤝 Égalité !'
    : `Tour de ${isXTurn ? '❌ X' : '⭕ O'}`;

  return (
    <div className="premium-card p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-semibold">{statusText}</div>
        <div className="flex gap-1">
          {(result || isDraw) && (
            <Button variant="outline" size="sm" onClick={reset} className="h-8 text-xs">
              Suivant
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={fullReset} className="h-8 text-xs">
            <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reset
          </Button>
        </div>
      </div>

      <div className="flex justify-center gap-6 mb-4 text-sm">
        <span className="font-semibold">❌ {scores.X}</span>
        <span className="text-muted-foreground">🤝 {scores.draws}</span>
        <span className="font-semibold">⭕ {scores.O}</span>
      </div>

      <div className="w-full max-w-[300px] mx-auto">
        <div className="grid grid-cols-3 gap-2">
          {cells.map((cell, i) => {
            const isWinning = result?.line.includes(i);
            return (
              <button
                key={i}
                onClick={() => handleClick(i)}
                className={`aspect-square rounded-xl flex items-center justify-center text-3xl sm:text-4xl font-bold transition-all duration-200
                  ${cell ? '' : 'hover:bg-primary/10 cursor-pointer'}
                  ${isWinning ? 'bg-primary/20 ring-2 ring-primary scale-105' : 'bg-secondary/60'}
                  ${!cell && !result ? 'active:scale-95' : ''}
                `}
                disabled={!!cell || !!result}
              >
                {cell === 'X' && <span className="text-primary">✕</span>}
                {cell === 'O' && <span className="text-destructive">○</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
