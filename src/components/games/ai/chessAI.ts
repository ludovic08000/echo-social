import { AIDifficulty } from '../GameLobby';

type Piece = string | null;
type Board = Piece[][];

const isWhite = (p: string) => '♔♕♖♗♘♙'.includes(p);
const isBlack = (p: string) => '♚♛♜♝♞♟'.includes(p);

const PIECE_VALUES: Record<string, number> = {
  '♙': 10, '♟': 10,
  '♘': 30, '♞': 30,
  '♗': 30, '♝': 30,
  '♖': 50, '♜': 50,
  '♕': 90, '♛': 90,
  '♔': 900, '♚': 900,
};

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

function evaluateBoard(board: Board): number {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const val = PIECE_VALUES[p] || 0;
      // Center control bonus
      const centerBonus = (3.5 - Math.abs(r - 3.5)) * 0.5 + (3.5 - Math.abs(c - 3.5)) * 0.5;
      if (isBlack(p)) {
        score += val + centerBonus;
      } else {
        score -= val - centerBonus;
      }
    }
  }
  return score;
}

function getAllMoves(board: Board, forBlack: boolean): { from: [number, number]; to: [number, number] }[] {
  const moves: { from: [number, number]; to: [number, number] }[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (forBlack ? !isBlack(p) : !isWhite(p)) continue;
      const valid = getValidMoves(board, r, c);
      for (const [tr, tc] of valid) {
        moves.push({ from: [r, c], to: [tr, tc] });
      }
    }
  }
  return moves;
}

function applyMove(board: Board, from: [number, number], to: [number, number]): Board {
  const nb = board.map(r => [...r]);
  nb[to[0]][to[1]] = nb[from[0]][from[1]];
  nb[from[0]][from[1]] = null;
  return nb;
}

function minimax(board: Board, depth: number, isMaximizing: boolean, alpha: number, beta: number): number {
  if (depth === 0) return evaluateBoard(board);

  const moves = getAllMoves(board, isMaximizing);
  if (moves.length === 0) return isMaximizing ? -9999 : 9999;

  if (isMaximizing) {
    let best = -Infinity;
    for (const m of moves) {
      const nb = applyMove(board, m.from, m.to);
      best = Math.max(best, minimax(nb, depth - 1, false, alpha, beta));
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      const nb = applyMove(board, m.from, m.to);
      best = Math.min(best, minimax(nb, depth - 1, true, alpha, beta));
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

const DEPTH_MAP: Record<AIDifficulty, number> = {
  easy: 1,
  medium: 2,
  hard: 3,
};

export function getChessAIMove(board: Board, difficulty: AIDifficulty): { from: [number, number]; to: [number, number] } | null {
  const moves = getAllMoves(board, true); // AI plays black
  if (moves.length === 0) return null;

  const depth = DEPTH_MAP[difficulty];

  // Easy: add randomness
  if (difficulty === 'easy' && Math.random() < 0.4) {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  let bestScore = -Infinity;
  let bestMove = moves[0];

  for (const m of moves) {
    const nb = applyMove(board, m.from, m.to);
    const score = minimax(nb, depth - 1, false, -Infinity, Infinity);
    // Add slight randomness for medium
    const noise = difficulty === 'medium' ? (Math.random() - 0.5) * 5 : 0;
    if (score + noise > bestScore) {
      bestScore = score + noise;
      bestMove = m;
    }
  }

  return bestMove;
}
