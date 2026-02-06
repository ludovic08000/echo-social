import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { RotateCcw } from 'lucide-react';

type Cell = 'R' | 'Y' | null;
type Board = Cell[][];

const ROWS = 6;
const COLS = 7;

function createBoard(): Board {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function checkWinner(board: Board): { winner: Cell; cells: [number, number][] } | null {
  const check = (r: number, c: number, dr: number, dc: number): [number, number][] | null => {
    const p = board[r][c];
    if (!p) return null;
    const cells: [number, number][] = [[r, c]];
    for (let i = 1; i < 4; i++) {
      const nr = r + dr * i, nc = c + dc * i;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || board[nr][nc] !== p) return null;
      cells.push([nr, nc]);
    }
    return cells;
  };

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
        const cells = check(r, c, dr, dc);
        if (cells) return { winner: board[r][c], cells };
      }
    }
  }
  return null;
}

export default function Connect4Game() {
  const [board, setBoard] = useState<Board>(createBoard);
  const [turn, setTurn] = useState<'R' | 'Y'>('R');
  const [scores, setScores] = useState({ R: 0, Y: 0 });
  const [hoverCol, setHoverCol] = useState<number | null>(null);

  const result = checkWinner(board);
  const isDraw = !result && board[0].every(c => c !== null);

  const reset = useCallback(() => {
    setBoard(createBoard());
    setTurn('R');
    setHoverCol(null);
  }, []);

  const fullReset = useCallback(() => {
    reset();
    setScores({ R: 0, Y: 0 });
  }, [reset]);

  const dropPiece = (col: number) => {
    if (result || isDraw) return;
    const newBoard = board.map(r => [...r]);
    for (let r = ROWS - 1; r >= 0; r--) {
      if (!newBoard[r][col]) {
        newBoard[r][col] = turn;
        setBoard(newBoard);
        const win = checkWinner(newBoard);
        if (win) {
          setScores(prev => ({ ...prev, [turn]: prev[turn] + 1 }));
        }
        setTurn(turn === 'R' ? 'Y' : 'R');
        return;
      }
    }
  };

  const isWinning = (r: number, c: number) => result?.cells.some(([wr, wc]) => wr === r && wc === c);

  const statusText = result
    ? `🏆 ${result.winner === 'R' ? '🔴 Rouge' : '🟡 Jaune'} gagne !`
    : isDraw
    ? '🤝 Égalité !'
    : `Tour de ${turn === 'R' ? '🔴 Rouge' : '🟡 Jaune'}`;

  return (
    <div className="premium-card p-4">
      <div className="flex items-center justify-between mb-3">
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

      <div className="flex justify-center gap-6 mb-3 text-sm">
        <span className="font-semibold">🔴 {scores.R}</span>
        <span className="font-semibold">🟡 {scores.Y}</span>
      </div>

      <div className="w-full max-w-[400px] mx-auto">
        {/* Column hover indicators */}
        <div className="grid grid-cols-7 gap-1 mb-1 px-1">
          {Array.from({ length: COLS }, (_, c) => (
            <button
              key={c}
              onMouseEnter={() => setHoverCol(c)}
              onMouseLeave={() => setHoverCol(null)}
              onClick={() => dropPiece(c)}
              className="h-6 flex items-center justify-center"
              disabled={!!result || board[0][c] !== null}
            >
              {hoverCol === c && !result && !board[0][c] && (
                <div className={`w-5 h-5 rounded-full opacity-50 ${turn === 'R' ? 'bg-destructive' : 'bg-yellow-400'}`} />
              )}
            </button>
          ))}
        </div>

        {/* Board */}
        <div className="bg-primary/90 rounded-xl p-1.5 shadow-lg">
          <div className="grid grid-rows-6 gap-1">
            {board.map((row, ri) => (
              <div key={ri} className="grid grid-cols-7 gap-1">
                {row.map((cell, ci) => (
                  <button
                    key={ci}
                    onClick={() => dropPiece(ci)}
                    className={`aspect-square rounded-full transition-all duration-200 border-2
                      ${!cell ? 'bg-background border-background hover:bg-muted' : ''}
                      ${cell === 'R' ? 'bg-destructive border-destructive/70 shadow-inner' : ''}
                      ${cell === 'Y' ? 'bg-yellow-400 border-yellow-500/70 shadow-inner' : ''}
                      ${isWinning(ri, ci) ? 'ring-2 ring-background scale-110 z-10' : ''}
                    `}
                    disabled={!!result || !!cell}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
