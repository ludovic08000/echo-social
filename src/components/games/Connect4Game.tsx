import { useState, useCallback, useEffect } from 'react';
import GameWrapper from './GameWrapper';
import GameLobby, { GameMode, AIDifficulty } from './GameLobby';
import { getConnect4AIMove } from './ai/connect4AI';

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
  const [gameStarted, setGameStarted] = useState(false);
  const [mode, setMode] = useState<GameMode>('local');
  const [difficulty, setDifficulty] = useState<AIDifficulty>('medium');
  const [friendName, setFriendName] = useState<string>();

  const [board, setBoard] = useState<Board>(createBoard);
  const [turn, setTurn] = useState<'R' | 'Y'>('R');
  const [scores, setScores] = useState({ R: 0, Y: 0 });
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const [lastDrop, setLastDrop] = useState<[number, number] | null>(null);

  const result = checkWinner(board);
  const isDraw = !result && board[0].every(c => c !== null);

  const reset = useCallback(() => {
    setBoard(createBoard());
    setTurn('R');
    setHoverCol(null);
    setLastDrop(null);
  }, []);

  const fullReset = useCallback(() => {
    reset();
    setScores({ R: 0, Y: 0 });
  }, [reset]);

  const dropPiece = useCallback((col: number) => {
    if (result || isDraw) return;
    const newBoard = board.map(r => [...r]);
    for (let r = ROWS - 1; r >= 0; r--) {
      if (!newBoard[r][col]) {
        newBoard[r][col] = turn;
        setBoard(newBoard);
        setLastDrop([r, col]);
        const win = checkWinner(newBoard);
        if (win) {
          setScores(prev => ({ ...prev, [turn]: prev[turn] + 1 }));
        }
        setTurn(turn === 'R' ? 'Y' : 'R');
        return;
      }
    }
  }, [board, turn, result, isDraw]);

  // AI move (Yellow)
  useEffect(() => {
    if (mode !== 'ai' || turn !== 'Y' || result || isDraw) return;
    const timer = setTimeout(() => {
      const col = getConnect4AIMove(board, difficulty);
      if (col !== null) dropPiece(col);
    }, 400);
    return () => clearTimeout(timer);
  }, [mode, turn, board, difficulty, result, isDraw, dropPiece]);

  const handleDrop = (col: number) => {
    if (mode === 'ai' && turn === 'Y') return;
    dropPiece(col);
  };

  const isWinning = (r: number, c: number) => result?.cells.some(([wr, wc]) => wr === r && wc === c);

  if (!gameStarted) {
    return (
      <GameLobby
        gameName="Puissance 4"
        gameIcon="🟡"
        onStart={(m, d, _fid, fn) => {
          setMode(m);
          if (d) setDifficulty(d);
          if (fn) setFriendName(fn);
          setGameStarted(true);
        }}
      />
    );
  }

  const statusText = result
    ? `🏆 ${result.winner === 'R' ? '🔴 Rouge' : '🟡 Jaune'} gagne !`
    : isDraw
    ? '🤝 Égalité !'
    : `Tour de ${turn === 'R' ? '🔴 Rouge' : '🟡 Jaune'}`;

  return (
    <GameWrapper
      status={statusText}
      onReset={fullReset}
      onBack={() => { fullReset(); setGameStarted(false); }}
      mode={mode}
      difficulty={difficulty}
      friendName={friendName}
      scores={
        <div className="flex justify-center gap-8 text-xs">
          <span className="font-semibold">🔴 {scores.R}</span>
          <span className="font-semibold">🟡 {scores.Y}</span>
        </div>
      }
    >
      <div className="w-full max-w-[380px] mx-auto">
        {/* Column hover indicators */}
        <div className="grid grid-cols-7 gap-1.5 mb-1.5 px-1">
          {Array.from({ length: COLS }, (_, c) => (
            <button
              key={c}
              onMouseEnter={() => setHoverCol(c)}
              onMouseLeave={() => setHoverCol(null)}
              onClick={() => handleDrop(c)}
              className="h-7 flex items-center justify-center rounded-full transition-colors"
              disabled={!!result || board[0][c] !== null}
            >
              {hoverCol === c && !result && !board[0][c] && (
                <div className={`w-6 h-6 rounded-full opacity-60 transition-all animate-pulse ${turn === 'R' ? 'bg-red-500' : 'bg-yellow-400'}`} />
              )}
            </button>
          ))}
        </div>

        {/* Board */}
        <div className="bg-gradient-to-b from-blue-600/90 to-blue-800/90 rounded-2xl p-2 shadow-xl border border-blue-500/30">
          <div className="grid grid-rows-6 gap-1.5">
            {board.map((row, ri) => (
              <div key={ri} className="grid grid-cols-7 gap-1.5">
                {row.map((cell, ci) => (
                  <button
                    key={ci}
                    onClick={() => handleDrop(ci)}
                    className={`aspect-square rounded-full transition-all duration-300 border-2 shadow-inner
                      ${!cell ? 'bg-background/90 border-background/60 hover:bg-muted/90' : ''}
                      ${cell === 'R' ? 'bg-gradient-to-br from-red-400 to-red-600 border-red-300/50' : ''}
                      ${cell === 'Y' ? 'bg-gradient-to-br from-yellow-300 to-yellow-500 border-yellow-200/50' : ''}
                      ${isWinning(ri, ci) ? 'ring-2 ring-white scale-110 z-10 shadow-lg' : ''}
                      ${lastDrop && lastDrop[0] === ri && lastDrop[1] === ci && !isWinning(ri, ci) ? 'ring-1 ring-white/40' : ''}
                    `}
                    disabled={!!result || !!cell}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        {(result || isDraw) && (
          <button
            onClick={reset}
            className="w-full mt-4 py-2.5 rounded-xl bg-primary/10 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors"
          >
            Manche suivante →
          </button>
        )}
      </div>
    </GameWrapper>
  );
}
