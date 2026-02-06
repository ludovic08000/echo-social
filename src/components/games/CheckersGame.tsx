import { useState, useCallback, useEffect } from 'react';
import GameWrapper from './GameWrapper';
import GameLobby, { GameMode, AIDifficulty } from './GameLobby';
import { getCheckersAIMove } from './ai/checkersAI';

type Cell = null | 'r' | 'b' | 'R' | 'B';
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
  const [gameStarted, setGameStarted] = useState(false);
  const [mode, setMode] = useState<GameMode>('local');
  const [difficulty, setDifficulty] = useState<AIDifficulty>('medium');
  const [friendName, setFriendName] = useState<string>();

  const [board, setBoard] = useState<Board>(createInitialBoard);
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const [validMoves, setValidMoves] = useState<{ to: [number, number]; capture?: [number, number] }[]>([]);
  const [turn, setTurn] = useState<'red' | 'black'>('red');
  const [scores, setScores] = useState({ red: 0, black: 0 });
  const [status, setStatus] = useState('');
  const [lastMove, setLastMove] = useState<{ from: [number, number]; to: [number, number] } | null>(null);

  const reset = useCallback(() => {
    setBoard(createInitialBoard());
    setSelected(null);
    setValidMoves([]);
    setTurn('red');
    setScores({ red: 0, black: 0 });
    setStatus('');
    setLastMove(null);
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

  // AI move
  useEffect(() => {
    if (mode !== 'ai' || turn !== 'black' || status) return;
    const timer = setTimeout(() => {
      const move = getCheckersAIMove(board, difficulty);
      if (move) {
        const newBoard = board.map(r => [...r]);
        newBoard[move.to[0]][move.to[1]] = newBoard[move.from[0]][move.from[1]];
        newBoard[move.from[0]][move.from[1]] = null;
        if (move.capture) {
          newBoard[move.capture[0]][move.capture[1]] = null;
          setScores(prev => ({ ...prev, black: prev.black + 1 }));
        }
        if (move.to[0] === 7 && newBoard[move.to[0]][move.to[1]] === 'b') newBoard[move.to[0]][move.to[1]] = 'B';
        setBoard(newBoard);
        setLastMove({ from: move.from, to: move.to });
        const win = checkWin(newBoard);
        if (win) setStatus(win);
        setTurn('red');
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [mode, turn, board, difficulty, status]);

  const handleClick = (row: number, col: number) => {
    if (status) return;
    if (mode === 'ai' && turn === 'black') return;
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
        if (row === 0 && movingPiece === 'r') newBoard[row][col] = 'R';
        if (row === 7 && movingPiece === 'b') newBoard[row][col] = 'B';
        if (move.capture) {
          const furtherCaptures = getValidMoves(newBoard, row, col).filter(m => m.capture);
          if (furtherCaptures.length > 0) {
            setBoard(newBoard);
            setSelected([row, col]);
            setValidMoves(furtherCaptures);
            setLastMove({ from: selected, to: [row, col] });
            return;
          }
        }
        setBoard(newBoard);
        setLastMove({ from: selected, to: [row, col] });
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
  const isLast = (r: number, c: number) => lastMove && ((lastMove.from[0] === r && lastMove.from[1] === c) || (lastMove.to[0] === r && lastMove.to[1] === c));

  if (!gameStarted) {
    return (
      <GameLobby
        gameName="Dames"
        gameIcon="🔴"
        onStart={(m, d, _fid, fn) => {
          setMode(m);
          if (d) setDifficulty(d);
          if (fn) setFriendName(fn);
          setGameStarted(true);
        }}
      />
    );
  }

  const statusText = status || (turn === 'red' ? '🔴 Tour des Rouges' : '⚫ Tour des Noirs');

  return (
    <GameWrapper
      status={statusText}
      onReset={reset}
      onBack={() => { reset(); setGameStarted(false); }}
      mode={mode}
      difficulty={difficulty}
      friendName={friendName}
      scores={
        <div className="flex justify-center gap-8 text-xs">
          <span className="font-semibold">🔴 Captures: {scores.red}</span>
          <span className="font-semibold">⚫ Captures: {scores.black}</span>
        </div>
      }
    >
      <div className="aspect-square w-full max-w-[400px] mx-auto">
        <div className="grid grid-cols-8 w-full h-full rounded-xl overflow-hidden border-2 border-border/50 shadow-lg">
          {board.map((row, ri) =>
            row.map((piece, ci) => {
              const isDark = (ri + ci) % 2 === 1;
              const isSelected = selected?.[0] === ri && selected?.[1] === ci;
              const isTarget = isValidTarget(ri, ci);
              const wasLast = isLast(ri, ci);
              return (
                <button
                  key={`${ri}-${ci}`}
                  className={`aspect-square flex items-center justify-center transition-all duration-150 relative
                    ${isDark ? 'bg-primary/15 dark:bg-primary/20' : 'bg-card dark:bg-card/80'}
                    ${isSelected ? 'ring-2 ring-primary ring-inset z-10' : ''}
                    ${wasLast ? 'bg-yellow-500/15' : ''}
                    hover:brightness-95 dark:hover:brightness-110
                  `}
                  onClick={() => handleClick(ri, ci)}
                  disabled={!isDark && !piece}
                >
                  {isTarget && !piece && (
                    <div className="w-3 h-3 rounded-full bg-primary/40 shadow-sm" />
                  )}
                  {piece && (
                    <div className={`w-[72%] h-[72%] rounded-full border-2 shadow-lg flex items-center justify-center text-xs font-bold transition-transform
                      ${isRed(piece) ? 'bg-gradient-to-br from-red-500 to-red-700 border-red-400/60 text-white' : 'bg-gradient-to-br from-zinc-700 to-zinc-900 border-zinc-500/60 text-white'}
                      ${isTarget ? 'ring-2 ring-primary ring-offset-1 ring-offset-transparent' : ''}
                      ${isSelected ? 'scale-110' : ''}
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
    </GameWrapper>
  );
}
