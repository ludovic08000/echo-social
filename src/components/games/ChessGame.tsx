import { useState, useCallback, useEffect } from 'react';
import GameWrapper from './GameWrapper';
import GameLobby, { GameMode, AIDifficulty } from './GameLobby';
import { getChessAIMove } from './ai/chessAI';

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
  const [gameStarted, setGameStarted] = useState(false);
  const [mode, setMode] = useState<GameMode>('local');
  const [difficulty, setDifficulty] = useState<AIDifficulty>('medium');
  const [friendName, setFriendName] = useState<string>();

  const [board, setBoard] = useState<Board>(() => INITIAL_BOARD.map(r => [...r]));
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const [validMoves, setValidMoves] = useState<[number, number][]>([]);
  const [turn, setTurn] = useState<'white' | 'black'>('white');
  const [captured, setCaptured] = useState<{ white: string[]; black: string[] }>({ white: [], black: [] });
  const [status, setStatus] = useState('');
  const [lastMove, setLastMove] = useState<{ from: [number, number]; to: [number, number] } | null>(null);

  const reset = useCallback(() => {
    setBoard(INITIAL_BOARD.map(r => [...r]));
    setSelected(null);
    setValidMoves([]);
    setTurn('white');
    setCaptured({ white: [], black: [] });
    setStatus('');
    setLastMove(null);
  }, []);

  // AI move
  useEffect(() => {
    if (mode !== 'ai' || turn !== 'black' || status) return;
    const timer = setTimeout(() => {
      const move = getChessAIMove(board, difficulty);
      if (move) {
        const newBoard = board.map(r => [...r]);
        const target = newBoard[move.to[0]][move.to[1]];
        if (target) {
          setCaptured(prev => ({ ...prev, black: [...prev.black, target] }));
          if (target === '♔') setStatus('🏆 Les Noirs gagnent !');
        }
        newBoard[move.to[0]][move.to[1]] = newBoard[move.from[0]][move.from[1]];
        newBoard[move.from[0]][move.from[1]] = null;
        setBoard(newBoard);
        setLastMove(move);
        setTurn('white');
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [mode, turn, board, difficulty, status]);

  const handleClick = (row: number, col: number) => {
    if (status) return;
    if (mode === 'ai' && turn === 'black') return;
    const piece = board[row][col];

    if (selected) {
      const isValid = validMoves.some(([r, c]) => r === row && c === col);
      if (isValid) {
        const newBoard = board.map(r => [...r]);
        const target = newBoard[row][col];
        if (target) {
          setCaptured(prev => ({ ...prev, [turn]: [...prev[turn], target] }));
          if (target === '♔' || target === '♚') {
            setStatus(turn === 'white' ? '🏆 Les Blancs gagnent !' : '🏆 Les Noirs gagnent !');
          }
        }
        newBoard[row][col] = newBoard[selected[0]][selected[1]];
        newBoard[selected[0]][selected[1]] = null;
        setBoard(newBoard);
        setLastMove({ from: selected, to: [row, col] });
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
  const isLastMove = (r: number, c: number) => lastMove && ((lastMove.from[0] === r && lastMove.from[1] === c) || (lastMove.to[0] === r && lastMove.to[1] === c));

  if (!gameStarted) {
    return (
      <GameLobby
        gameName="Échecs"
        gameIcon="♟️"
        onStart={(m, d, _fid, fn) => {
          setMode(m);
          if (d) setDifficulty(d);
          if (fn) setFriendName(fn);
          setGameStarted(true);
        }}
      />
    );
  }

  const statusText = status || (turn === 'white' ? '⬜ Tour des Blancs' : '⬛ Tour des Noirs');

  return (
    <GameWrapper
      status={statusText}
      onReset={reset}
      onBack={() => { reset(); setGameStarted(false); }}
      mode={mode}
      difficulty={difficulty}
      friendName={friendName}
      scores={
        <div className="flex justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-foreground">⬜ Blancs</span>
            <div className="flex gap-0.5 flex-wrap">{captured.black.map((p, i) => <span key={i} className="text-sm opacity-70">{p}</span>)}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex gap-0.5 flex-wrap">{captured.white.map((p, i) => <span key={i} className="text-sm opacity-70">{p}</span>)}</div>
            <span className="font-semibold text-foreground">⬛ Noirs</span>
          </div>
        </div>
      }
    >
      <div className="aspect-square w-full max-w-[400px] mx-auto">
        {/* Column labels */}
        <div className="grid grid-cols-8 gap-0 mb-0.5 px-0.5">
          {['a','b','c','d','e','f','g','h'].map(l => (
            <div key={l} className="text-center text-[9px] text-muted-foreground font-mono">{l}</div>
          ))}
        </div>
        <div className="grid grid-cols-8 w-full h-full rounded-xl overflow-hidden border-2 border-border/50 shadow-lg">
          {board.map((row, ri) =>
            row.map((piece, ci) => {
              const isDark = (ri + ci) % 2 === 1;
              const isSelected = selected?.[0] === ri && selected?.[1] === ci;
              const isTarget = isValidTarget(ri, ci);
              const isLast = isLastMove(ri, ci);
              return (
                <button
                  key={`${ri}-${ci}`}
                  className={`aspect-square flex items-center justify-center text-2xl sm:text-3xl transition-all duration-150 relative
                    ${isDark ? 'bg-primary/15 dark:bg-primary/20' : 'bg-card dark:bg-card/80'}
                    ${isSelected ? 'ring-2 ring-primary ring-inset bg-primary/30 z-10' : ''}
                    ${isLast ? 'bg-yellow-500/15' : ''}
                    ${isTarget ? 'cursor-pointer' : ''}
                    hover:brightness-95 dark:hover:brightness-110
                  `}
                  onClick={() => handleClick(ri, ci)}
                >
                  {isTarget && !piece && (
                    <div className="w-3 h-3 rounded-full bg-primary/40 shadow-sm" />
                  )}
                  {isTarget && piece && (
                    <div className="absolute inset-0.5 ring-2 ring-primary/60 ring-inset rounded-sm" />
                  )}
                  {piece && <span className="drop-shadow-md select-none">{piece}</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </GameWrapper>
  );
}
