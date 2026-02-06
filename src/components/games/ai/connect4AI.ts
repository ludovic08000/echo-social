import { AIDifficulty } from '../GameLobby';

type Cell = 'R' | 'Y' | null;
type Board = Cell[][];
const ROWS = 6, COLS = 7;

function checkWin(board: Board): Cell | null {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
        const p = board[r][c];
        if (!p) continue;
        let count = 1;
        for (let i = 1; i < 4; i++) {
          const nr = r + dr * i, nc = c + dc * i;
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || board[nr][nc] !== p) break;
          count++;
        }
        if (count >= 4) return p;
      }
    }
  }
  return null;
}

function getDropRow(board: Board, col: number): number {
  for (let r = ROWS - 1; r >= 0; r--) {
    if (!board[r][col]) return r;
  }
  return -1;
}

function evaluate(board: Board): number {
  let score = 0;
  // Center column preference
  for (let r = 0; r < ROWS; r++) {
    if (board[r][3] === 'Y') score += 3;
    else if (board[r][3] === 'R') score -= 3;
  }

  // Evaluate windows of 4
  const evalWindow = (cells: Cell[]) => {
    const yCount = cells.filter(c => c === 'Y').length;
    const rCount = cells.filter(c => c === 'R').length;
    const empty = cells.filter(c => !c).length;
    if (yCount === 4) return 100;
    if (yCount === 3 && empty === 1) return 5;
    if (yCount === 2 && empty === 2) return 2;
    if (rCount === 4) return -100;
    if (rCount === 3 && empty === 1) return -4;
    return 0;
  };

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      score += evalWindow([board[r][c], board[r][c+1], board[r][c+2], board[r][c+3]]);
    }
  }
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r <= ROWS - 4; r++) {
      score += evalWindow([board[r][c], board[r+1][c], board[r+2][c], board[r+3][c]]);
    }
  }
  for (let r = 0; r <= ROWS - 4; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      score += evalWindow([board[r][c], board[r+1][c+1], board[r+2][c+2], board[r+3][c+3]]);
    }
  }
  for (let r = 3; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      score += evalWindow([board[r][c], board[r-1][c+1], board[r-2][c+2], board[r-3][c+3]]);
    }
  }
  return score;
}

function minimax(board: Board, depth: number, isMax: boolean, alpha: number, beta: number): number {
  const winner = checkWin(board);
  if (winner === 'Y') return 10000 + depth;
  if (winner === 'R') return -10000 - depth;
  if (board[0].every(c => c !== null)) return 0;
  if (depth === 0) return evaluate(board);

  const validCols = [3,2,4,1,5,0,6].filter(c => board[0][c] === null);

  if (isMax) {
    let best = -Infinity;
    for (const col of validCols) {
      const r = getDropRow(board, col);
      if (r < 0) continue;
      const nb = board.map(row => [...row]);
      nb[r][col] = 'Y';
      best = Math.max(best, minimax(nb, depth - 1, false, alpha, beta));
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const col of validCols) {
      const r = getDropRow(board, col);
      if (r < 0) continue;
      const nb = board.map(row => [...row]);
      nb[r][col] = 'R';
      best = Math.min(best, minimax(nb, depth - 1, true, alpha, beta));
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

const DEPTH: Record<AIDifficulty, number> = { easy: 1, medium: 3, hard: 5 };

export function getConnect4AIMove(board: Board, difficulty: AIDifficulty): number | null {
  const validCols = [3,2,4,1,5,0,6].filter(c => board[0][c] === null);
  if (validCols.length === 0) return null;

  if (difficulty === 'easy' && Math.random() < 0.5) {
    return validCols[Math.floor(Math.random() * validCols.length)];
  }

  let bestScore = -Infinity;
  let bestCol = validCols[0];

  for (const col of validCols) {
    const r = getDropRow(board, col);
    if (r < 0) continue;
    const nb = board.map(row => [...row]);
    nb[r][col] = 'Y'; // AI = Yellow
    const score = minimax(nb, DEPTH[difficulty] - 1, false, -Infinity, Infinity);
    const noise = difficulty === 'medium' ? (Math.random() - 0.5) * 4 : 0;
    if (score + noise > bestScore) {
      bestScore = score + noise;
      bestCol = col;
    }
  }
  return bestCol;
}
