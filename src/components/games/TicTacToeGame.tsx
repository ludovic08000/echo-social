import { useState, useCallback, useEffect } from 'react';
import GameWrapper from './GameWrapper';
import GameLobby, { GameMode, AIDifficulty } from './GameLobby';
import { getTicTacToeAIMove } from './ai/tictactoeAI';

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
  const [gameStarted, setGameStarted] = useState(false);
  const [mode, setMode] = useState<GameMode>('local');
  const [difficulty, setDifficulty] = useState<AIDifficulty>('medium');
  const [friendName, setFriendName] = useState<string>();

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

  // AI move (O)
  useEffect(() => {
    if (mode !== 'ai' || isXTurn || result || isDraw) return;
    const timer = setTimeout(() => {
      const move = getTicTacToeAIMove(cells, difficulty);
      if (move !== null) {
        const newCells = [...cells];
        newCells[move] = 'O';
        setCells(newCells);
        const newResult = checkWinner(newCells);
        if (newResult) {
          setScores(prev => ({ ...prev, [newResult.winner!]: prev[newResult.winner!] + 1 }));
        } else if (newCells.every(c => c !== null)) {
          setScores(prev => ({ ...prev, draws: prev.draws + 1 }));
        }
        setIsXTurn(true);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [mode, isXTurn, cells, difficulty, result, isDraw]);

  const handleClick = (index: number) => {
    if (cells[index] || result) return;
    if (mode === 'ai' && !isXTurn) return;
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

  if (!gameStarted) {
    return (
      <GameLobby
        gameName="Morpion"
        gameIcon="❌"
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
    ? `🏆 ${result.winner} gagne !`
    : isDraw
    ? '🤝 Égalité !'
    : `Tour de ${isXTurn ? '❌ X' : '⭕ O'}`;

  return (
    <GameWrapper
      status={statusText}
      onReset={fullReset}
      onBack={() => { fullReset(); setGameStarted(false); }}
      mode={mode}
      difficulty={difficulty}
      friendName={friendName}
      scores={
        <div className="flex justify-center gap-6 text-xs">
          <span className="font-semibold">❌ {scores.X}</span>
          <span className="text-muted-foreground">🤝 {scores.draws}</span>
          <span className="font-semibold">⭕ {scores.O}</span>
        </div>
      }
    >
      <div className="w-full max-w-[280px] mx-auto">
        <div className="grid grid-cols-3 gap-2.5">
          {cells.map((cell, i) => {
            const isWinning = result?.line.includes(i);
            return (
              <button
                key={i}
                onClick={() => handleClick(i)}
                className={`aspect-square rounded-2xl flex items-center justify-center text-3xl sm:text-4xl font-bold transition-all duration-200 border border-border/50
                  ${cell ? '' : 'hover:bg-primary/10 hover:border-primary/30 cursor-pointer'}
                  ${isWinning ? 'bg-primary/20 border-primary scale-105 shadow-lg shadow-primary/20' : 'bg-card/60'}
                  ${!cell && !result ? 'active:scale-95' : ''}
                `}
                disabled={!!cell || !!result}
              >
                {cell === 'X' && <span className="text-primary drop-shadow-sm">✕</span>}
                {cell === 'O' && <span className="text-destructive drop-shadow-sm">○</span>}
              </button>
            );
          })}
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
