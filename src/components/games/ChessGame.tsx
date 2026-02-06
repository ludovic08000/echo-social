import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { RotateCcw } from 'lucide-react';

type Piece = string | null;
type Board = Piece[][];

const INITIAL_BOARD: Board = [
  ['♜','♞','♝','♛','♚','♝','♞','♜'],
  ['♟','♟','♟','♟','♟','♟','♟','♟'],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  ['♙','♙','♙','♙','♙','♙','♙','♙'],
  ['♖','♘','♗','♕','♔','♗','♘','♖'],
];

const isWhite = (p: string) => '♔♕♖♗♘♙'.includes(p);
const isBlack = (p: string) => '♚♛♜♝♞♟'.includes(p);

function getValidMoves(board: Board, row: number, col: number): [number, number][] {
  const piece = board[row][col];
  if (!piece) return [];
  const moves: [number, number][] = [];
  const white = isWhite(piece);
  const canMove = (r: number, c: number) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const isEnemy = (r: number, c: number) => {
    const t = board[r][c];
    return t ? (white ? isBlack(t) : isWhite(t)) : false;
  };
  const isEmpty = (r: number, c: number) => !board[r][c];
  const addIfValid = (r: number, c: number) => {
    if (canMove(r, c) && (isEmpty(r, c) || isEnemy(r, c))) moves.push([r, c]);
  };
  const addLine = (dr: number, dc: number) => {
    for (let i = 1; i < 8; i++) {
      const nr = row + dr * i, nc = col + dc * i;
      if (!canMove(nr, nc)) break;
      if (isEmpty(nr, nc)) { moves.push([nr, nc]); continue; }
      if (isEnemy(nr, nc)) moves.push([nr, nc]);
      break;
    }
  };

  const base = piece.normalize('NFC');
  if (base === '♙' || base === '♟') {
    const dir = white ? -1 : 1;
    const start = white ? 6 : 1;
    if (canMove(row + dir, col) && isEmpty(row + dir, col)) {
      moves.push([row + dir, col]);
      if (row === start && isEmpty(row + 2 * dir, col)) moves.push([row + 2 * dir, col]);
    }
    if (canMove(row + dir, col - 1) && isEnemy(row + dir, col - 1)) moves.push([row + dir, col - 1]);
    if (canMove(row + dir, col + 1) && isEnemy(row + dir, col + 1)) moves.push([row + dir, col + 1]);
  } else if (base === '♖' || base === '♜') {
    [[-1,0],[1,0],[0,-1],[0,1]].forEach(([dr,dc]) => addLine(dr, dc));
  } else if (base === '♗' || base === '♝') {
    [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc]) => addLine(dr, dc));
  } else if (base === '♕' || base === '♛') {
    [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc]) => addLine(dr, dc));
  } else if (base === '♘' || base === '♞') {
    [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => addIfValid(row+dr, col+dc));
  } else if (base === '♔' || base === '♚') {
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => addIfValid(row+dr, col+dc));
  }
  return moves;
}

export default function ChessGame() {
  const [board, setBoard] = useState<Board>(() => INITIAL_BOARD.map(r => [...r]));
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const [validMoves, setValidMoves] = useState<[number, number][]>([]);
  const [turn, setTurn] = useState<'white' | 'black'>('white');
  const [captured, setCaptured] = useState<{ white: string[]; black: string[] }>({ white: [], black: [] });
  const [status, setStatus] = useState('');

  const reset = useCallback(() => {
    setBoard(INITIAL_BOARD.map(r => [...r]));
    setSelected(null);
    setValidMoves([]);
    setTurn('white');
    setCaptured({ white: [], black: [] });
    setStatus('');
  }, []);

  const handleClick = (row: number, col: number) => {
    if (status) return;
    const piece = board[row][col];

    if (selected) {
      const isValid = validMoves.some(([r, c]) => r === row && c === col);
      if (isValid) {
        const newBoard = board.map(r => [...r]);
        const target = newBoard[row][col];
        if (target) {
          setCaptured(prev => ({
            ...prev,
            [turn]: [...prev[turn], target],
          }));
          if (target === '♔' || target === '♚') {
            setStatus(turn === 'white' ? '🏆 Les Blancs gagnent !' : '🏆 Les Noirs gagnent !');
          }
        }
        newBoard[row][col] = newBoard[selected[0]][selected[1]];
        newBoard[selected[0]][selected[1]] = null;
        setBoard(newBoard);
        setTurn(turn === 'white' ? 'black' : 'white');
        setSelected(null);
        setValidMoves([]);
        return;
      }
      if (piece && ((turn === 'white' && isWhite(piece)) || (turn === 'black' && isBlack(piece)))) {
        setSelected([row, col]);
        setValidMoves(getValidMoves(board, row, col));
        return;
      }
      setSelected(null);
      setValidMoves([]);
      return;
    }

    if (piece && ((turn === 'white' && isWhite(piece)) || (turn === 'black' && isBlack(piece)))) {
      setSelected([row, col]);
      setValidMoves(getValidMoves(board, row, col));
    }
  };

  const isValidTarget = (r: number, c: number) => validMoves.some(([vr, vc]) => vr === r && vc === c);

  return (
    <div className="premium-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold">
          {status || (turn === 'white' ? '⬜ Tour des Blancs' : '⬛ Tour des Noirs')}
        </div>
        <Button variant="ghost" size="sm" onClick={reset} className="h-8 text-xs">
          <RotateCcw className="w-3.5 h-3.5 mr-1" /> Rejouer
        </Button>
      </div>

      {/* Captured pieces */}
      <div className="flex justify-between mb-2 text-sm min-h-[24px]">
        <div className="flex gap-0.5 flex-wrap">{captured.black.map((p, i) => <span key={i}>{p}</span>)}</div>
        <div className="flex gap-0.5 flex-wrap">{captured.white.map((p, i) => <span key={i}>{p}</span>)}</div>
      </div>

      {/* Board */}
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
                  className={`aspect-square flex items-center justify-center text-2xl sm:text-3xl transition-all duration-150 relative
                    ${isDark ? 'bg-primary/20' : 'bg-card'}
                    ${isSelected ? 'ring-2 ring-primary ring-inset bg-primary/30' : ''}
                    ${isTarget ? 'cursor-pointer' : ''}
                    hover:brightness-90
                  `}
                  onClick={() => handleClick(ri, ci)}
                >
                  {isTarget && !piece && (
                    <div className="w-3 h-3 rounded-full bg-primary/40" />
                  )}
                  {isTarget && piece && (
                    <div className="absolute inset-0 ring-2 ring-primary/60 ring-inset rounded-sm" />
                  )}
                  {piece && <span className="drop-shadow-sm">{piece}</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
