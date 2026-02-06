import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { RotateCcw } from 'lucide-react';

type Cell = null | 'r' | 'b' | 'R' | 'B'; // r/R = red, b/B = black (caps = king)
type Board = Cell[][];

function createInitialBoard(): Board {
  const board: Board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 8; c++)
      if ((r + c) % 2 === 1) board[r][c] = 'b';
  for (let r = 5; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if ((r + c) % 2 === 1) board[r][c] = 'r';
  return board;
}

const isRed = (p: Cell) => p === 'r' || p === 'R';
const isBlack = (p: Cell) => p === 'b' || p === 'B';
const isKing = (p: Cell) => p === 'R' || p === 'B';

function getValidMoves(board: Board, row: number, col: number): { to: [number, number]; capture?: [number, number] }[] {
  const piece = board[row][col];
  if (!piece) return [];
  const moves: { to: [number, number]; capture?: [number, number] }[] = [];
  const dirs = isKing(piece) ? [-1, 1] : isRed(piece) ? [-1] : [1];
  const enemy = isRed(piece) ? isBlack : isRed;

  for (const dr of dirs) {
    for (const dc of [-1, 1]) {
      const nr = row + dr, nc = col + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        if (!board[nr][nc]) {
          moves.push({ to: [nr, nc] });
        } else if (enemy(board[nr][nc])) {
          const jr = nr + dr, jc = nc + dc;
          if (jr >= 0 && jr < 8 && jc >= 0 && jc < 8 && !board[jr][jc]) {
            moves.push({ to: [jr, jc], capture: [nr, nc] });
          }
        }
      }
    }
  }
  return moves;
}

function hasCaptures(board: Board, isRedTurn: boolean): boolean {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && (isRedTurn ? isRed(p) : isBlack(p))) {
        if (getValidMoves(board, r, c).some(m => m.capture)) return true;
      }
    }
  return false;
}

export default function CheckersGame() {
  const [board, setBoard] = useState<Board>(createInitialBoard);
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const [validMoves, setValidMoves] = useState<{ to: [number, number]; capture?: [number, number] }[]>([]);
  const [turn, setTurn] = useState<'red' | 'black'>('red');
  const [scores, setScores] = useState({ red: 0, black: 0 });
  const [status, setStatus] = useState('');

  const reset = useCallback(() => {
    setBoard(createInitialBoard());
    setSelected(null);
    setValidMoves([]);
    setTurn('red');
    setScores({ red: 0, black: 0 });
    setStatus('');
  }, []);

  const checkWin = (b: Board) => {
    let reds = 0, blacks = 0;
    for (const row of b) for (const cell of row) {
      if (isRed(cell)) reds++;
      if (isBlack(cell)) blacks++;
    }
    if (reds === 0) return '🏆 Les Noirs gagnent !';
    if (blacks === 0) return '🏆 Les Rouges gagnent !';
    return '';
  };

  const handleClick = (row: number, col: number) => {
    if (status) return;
    const piece = board[row][col];
    const isMyPiece = piece && (turn === 'red' ? isRed(piece) : isBlack(piece));

    if (selected) {
      const move = validMoves.find(m => m.to[0] === row && m.to[1] === col);
      if (move) {
        const newBoard = board.map(r => [...r]);
        const movingPiece = newBoard[selected[0]][selected[1]];
        newBoard[row][col] = movingPiece;
        newBoard[selected[0]][selected[1]] = null;

        if (move.capture) {
          newBoard[move.capture[0]][move.capture[1]] = null;
          setScores(prev => ({ ...prev, [turn]: prev[turn] + 1 }));
        }

        // King promotion
        if (row === 0 && movingPiece === 'r') newBoard[row][col] = 'R';
        if (row === 7 && movingPiece === 'b') newBoard[row][col] = 'B';

        // Check for chain captures
        if (move.capture) {
          const furtherCaptures = getValidMoves(newBoard, row, col).filter(m => m.capture);
          if (furtherCaptures.length > 0) {
            setBoard(newBoard);
            setSelected([row, col]);
            setValidMoves(furtherCaptures);
            return;
          }
        }

        setBoard(newBoard);
        const win = checkWin(newBoard);
        if (win) setStatus(win);
        setTurn(turn === 'red' ? 'black' : 'red');
        setSelected(null);
        setValidMoves([]);
        return;
      }

      if (isMyPiece) {
        const mustCapture = hasCaptures(board, turn === 'red');
        let moves = getValidMoves(board, row, col);
        if (mustCapture) moves = moves.filter(m => m.capture);
        setSelected([row, col]);
        setValidMoves(moves);
        return;
      }

      setSelected(null);
      setValidMoves([]);
      return;
    }

    if (isMyPiece) {
      const mustCapture = hasCaptures(board, turn === 'red');
      let moves = getValidMoves(board, row, col);
      if (mustCapture) moves = moves.filter(m => m.capture);
      setSelected([row, col]);
      setValidMoves(moves);
    }
  };

  const isValidTarget = (r: number, c: number) => validMoves.some(m => m.to[0] === r && m.to[1] === c);

  return (
    <div className="premium-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold">
          {status || (turn === 'red' ? '🔴 Tour des Rouges' : '⚫ Tour des Noirs')}
        </div>
        <Button variant="ghost" size="sm" onClick={reset} className="h-8 text-xs">
          <RotateCcw className="w-3.5 h-3.5 mr-1" /> Rejouer
        </Button>
      </div>

      <div className="flex justify-between mb-2 text-xs text-muted-foreground">
        <span>🔴 Captures: {scores.red}</span>
        <span>⚫ Captures: {scores.black}</span>
      </div>

      <div className="aspect-square w-full max-w-[400px] mx-auto">
        <div className="grid grid-cols-8 w-full h-full rounded-lg overflow-hidden border border-border">
          {board.map((row, ri) =>
            row.map((piece, ci) => {
              const isDark = (ri + ci) % 2 === 1;
              const isSelected = selected?.[0] === ri && selected?.[1] === ci;
              const isTarget = isValidTarget(ri, ci);
              return (
                <button
                  key={`${ri}-${ci}`}
                  className={`aspect-square flex items-center justify-center transition-all duration-150 relative
                    ${isDark ? 'bg-primary/20' : 'bg-card'}
                    ${isSelected ? 'ring-2 ring-primary ring-inset' : ''}
                    hover:brightness-90
                  `}
                  onClick={() => handleClick(ri, ci)}
                  disabled={!isDark && !piece}
                >
                  {isTarget && !piece && (
                    <div className="w-3 h-3 rounded-full bg-primary/40" />
                  )}
                  {piece && (
                    <div className={`w-[70%] h-[70%] rounded-full border-2 shadow-md flex items-center justify-center text-xs font-bold
                      ${isRed(piece) ? 'bg-destructive border-destructive/80 text-destructive-foreground' : 'bg-foreground border-foreground/80 text-background'}
                      ${isTarget ? 'ring-2 ring-primary' : ''}
                    `}>
                      {isKing(piece) && '👑'}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
