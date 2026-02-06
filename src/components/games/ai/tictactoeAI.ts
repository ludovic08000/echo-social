import { AIDifficulty } from '../GameLobby';

type Cell = 'X' | 'O' | null;

const WINNING_LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
];

function checkWin(cells: Cell[]): Cell | null {
  for (const [a,b,c] of WINNING_LINES) {
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
  }
  return null;
}

function minimax(cells: Cell[], isMax: boolean): number {
  const winner = checkWin(cells);
  if (winner === 'O') return 10;
  if (winner === 'X') return -10;
  if (cells.every(c => c !== null)) return 0;

  if (isMax) {
    let best = -Infinity;
    for (let i = 0; i < 9; i++) {
      if (cells[i]) continue;
      cells[i] = 'O';
      best = Math.max(best, minimax(cells, false));
      cells[i] = null;
    }
    return best;
  } else {
    let best = Infinity;
    for (let i = 0; i < 9; i++) {
      if (cells[i]) continue;
      cells[i] = 'X';
      best = Math.min(best, minimax(cells, true));
      cells[i] = null;
    }
    return best;
  }
}

export function getTicTacToeAIMove(cells: Cell[], difficulty: AIDifficulty): number | null {
  const empty = cells.map((c, i) => c === null ? i : -1).filter(i => i >= 0);
  if (empty.length === 0) return null;

  // Easy: random
  if (difficulty === 'easy') {
    return empty[Math.floor(Math.random() * empty.length)];
  }

  // Medium: mix of random + optimal
  if (difficulty === 'medium' && Math.random() < 0.3) {
    return empty[Math.floor(Math.random() * empty.length)];
  }

  // Hard / Medium fallback: minimax
  let bestScore = -Infinity;
  let bestMove = empty[0];
  const copy = [...cells];

  for (const i of empty) {
    copy[i] = 'O';
    const score = minimax(copy, false);
    copy[i] = null;
    if (score > bestScore) {
      bestScore = score;
      bestMove = i;
    }
  }

  return bestMove;
}
