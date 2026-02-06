import { AIDifficulty } from '../GameLobby';

type Cell = null | 'r' | 'b' | 'R' | 'B';
type Board = Cell[][];

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

function getAllMoves(board: Board, forBlack: boolean): { from: [number, number]; moves: { to: [number, number]; capture?: [number, number] }[] }[] {
  const result: { from: [number, number]; moves: { to: [number, number]; capture?: [number, number] }[] }[] = [];
  let hasCaptures = false;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || (forBlack ? !isBlack(p) : !isRed(p))) continue;
      const moves = getValidMoves(board, r, c);
      if (moves.some(m => m.capture)) hasCaptures = true;
      if (moves.length > 0) result.push({ from: [r, c], moves });
    }
  }

  if (hasCaptures) {
    return result.map(r => ({
      ...r,
      moves: r.moves.filter(m => m.capture)
    })).filter(r => r.moves.length > 0);
  }
  return result;
}

function evaluate(board: Board): number {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (isBlack(p)) {
        score += isKing(p) ? 5 : 3;
        score += r * 0.1; // Advance bonus
      } else {
        score -= isKing(p) ? 5 : 3;
        score -= (7 - r) * 0.1;
      }
    }
  }
  return score;
}

function applyMove(board: Board, from: [number, number], to: [number, number], capture?: [number, number]): Board {
  const nb = board.map(r => [...r]);
  nb[to[0]][to[1]] = nb[from[0]][from[1]];
  nb[from[0]][from[1]] = null;
  if (capture) nb[capture[0]][capture[1]] = null;
  // King promotion
  if (to[0] === 7 && nb[to[0]][to[1]] === 'b') nb[to[0]][to[1]] = 'B';
  if (to[0] === 0 && nb[to[0]][to[1]] === 'r') nb[to[0]][to[1]] = 'R';
  return nb;
}

function minimax(board: Board, depth: number, isMax: boolean, alpha: number, beta: number): number {
  if (depth === 0) return evaluate(board);

  const allMoves = getAllMoves(board, isMax);
  if (allMoves.length === 0) return isMax ? -999 : 999;

  if (isMax) {
    let best = -Infinity;
    for (const piece of allMoves) {
      for (const move of piece.moves) {
        const nb = applyMove(board, piece.from, move.to, move.capture);
        best = Math.max(best, minimax(nb, depth - 1, false, alpha, beta));
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const piece of allMoves) {
      for (const move of piece.moves) {
        const nb = applyMove(board, piece.from, move.to, move.capture);
        best = Math.min(best, minimax(nb, depth - 1, true, alpha, beta));
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
      if (beta <= alpha) break;
    }
    return best;
  }
}

const DEPTH: Record<AIDifficulty, number> = { easy: 1, medium: 3, hard: 5 };

export function getCheckersAIMove(board: Board, difficulty: AIDifficulty): { from: [number, number]; to: [number, number]; capture?: [number, number] } | null {
  const allMoves = getAllMoves(board, true); // AI = black
  if (allMoves.length === 0) return null;

  if (difficulty === 'easy' && Math.random() < 0.5) {
    const rp = allMoves[Math.floor(Math.random() * allMoves.length)];
    const rm = rp.moves[Math.floor(Math.random() * rp.moves.length)];
    return { from: rp.from, ...rm };
  }

  let bestScore = -Infinity;
  let bestResult: { from: [number, number]; to: [number, number]; capture?: [number, number] } | null = null;

  for (const piece of allMoves) {
    for (const move of piece.moves) {
      const nb = applyMove(board, piece.from, move.to, move.capture);
      const score = minimax(nb, DEPTH[difficulty] - 1, false, -Infinity, Infinity);
      const noise = difficulty === 'medium' ? (Math.random() - 0.5) * 2 : 0;
      if (score + noise > bestScore) {
        bestScore = score + noise;
        bestResult = { from: piece.from, ...move };
      }
    }
  }
  return bestResult;
}
