import { useState, useEffect, useCallback, useRef, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Play, RotateCcw, ArrowLeft, ArrowRight, ArrowDown, RotateCw } from 'lucide-react';

const COLS = 10;
const ROWS = 20;
const BASE_SPEED = 500;

type Grid = (string | null)[][];
type Piece = { shape: number[][]; color: string };

const PIECES: Piece[] = [
  { shape: [[1,1,1,1]], color: 'bg-cyan-500' },            // I
  { shape: [[1,1],[1,1]], color: 'bg-yellow-500' },         // O
  { shape: [[0,1,0],[1,1,1]], color: 'bg-purple-500' },     // T
  { shape: [[1,0],[1,0],[1,1]], color: 'bg-orange-500' },   // L
  { shape: [[0,1],[0,1],[1,1]], color: 'bg-blue-500' },     // J
  { shape: [[0,1,1],[1,1,0]], color: 'bg-green-500' },      // S
  { shape: [[1,1,0],[0,1,1]], color: 'bg-red-500' },        // Z
];

function createGrid(): Grid {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function rotate(shape: number[][]): number[][] {
  const rows = shape.length;
  const cols = shape[0].length;
  return Array.from({ length: cols }, (_, c) =>
    Array.from({ length: rows }, (_, r) => shape[rows - 1 - r][c])
  );
}

function isValid(grid: Grid, shape: number[][], row: number, col: number): boolean {
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const gr = row + r;
      const gc = col + c;
      if (gr < 0 || gr >= ROWS || gc < 0 || gc >= COLS) return false;
      if (grid[gr][gc]) return false;
    }
  }
  return true;
}

function merge(grid: Grid, shape: number[][], row: number, col: number, color: string): Grid {
  const newGrid = grid.map(r => [...r]);
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) {
        newGrid[row + r][col + c] = color;
      }
    }
  }
  return newGrid;
}

function clearLines(grid: Grid): { grid: Grid; cleared: number } {
  const newGrid = grid.filter(row => row.some(cell => !cell));
  const cleared = ROWS - newGrid.length;
  while (newGrid.length < ROWS) {
    newGrid.unshift(Array(COLS).fill(null));
  }
  return { grid: newGrid, cleared };
}

function randomPiece(): Piece {
  return PIECES[Math.floor(Math.random() * PIECES.length)];
}

const TetrisGame = forwardRef<HTMLDivElement>((_, ref) => {
  const [grid, setGrid] = useState(createGrid);
  const [current, setCurrent] = useState(randomPiece);
  const [next, setNext] = useState(randomPiece);
  const [pos, setPos] = useState({ row: 0, col: 3 });
  const [phase, setPhase] = useState<'idle' | 'playing' | 'over'>('idle');
  const [score, setScore] = useState(0);
  const [lines, setLines] = useState(0);
  const [level, setLevel] = useState(1);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentRef = useRef(current);
  const posRef = useRef(pos);
  const gridRef = useRef(grid);

  currentRef.current = current;
  posRef.current = pos;
  gridRef.current = grid;

  const spawnPiece = useCallback(() => {
    const np = next;
    const startCol = Math.floor((COLS - np.shape[0].length) / 2);
    if (!isValid(gridRef.current, np.shape, 0, startCol)) {
      setPhase('over');
      return;
    }
    setCurrent(np);
    setPos({ row: 0, col: startCol });
    setNext(randomPiece());
  }, [next]);

  const lock = useCallback(() => {
    const p = posRef.current;
    const c = currentRef.current;
    const merged = merge(gridRef.current, c.shape, p.row, p.col, c.color);
    const { grid: cleared, cleared: linesCleared } = clearLines(merged);
    setGrid(cleared);
    gridRef.current = cleared;

    if (linesCleared > 0) {
      const points = [0, 100, 300, 500, 800][linesCleared] || 0;
      setScore(s => s + points * level);
      setLines(l => {
        const nl = l + linesCleared;
        setLevel(Math.floor(nl / 10) + 1);
        return nl;
      });
    }

    spawnPiece();
  }, [level, spawnPiece]);

  const drop = useCallback(() => {
    const p = posRef.current;
    const c = currentRef.current;
    if (isValid(gridRef.current, c.shape, p.row + 1, p.col)) {
      setPos(prev => ({ ...prev, row: prev.row + 1 }));
    } else {
      lock();
    }
  }, [lock]);

  useEffect(() => {
    if (phase !== 'playing') {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    const speed = Math.max(80, BASE_SPEED - (level - 1) * 40);
    intervalRef.current = setInterval(drop, speed);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [phase, level, drop]);

  useEffect(() => {
    if (phase !== 'playing') return;
    const handler = (e: KeyboardEvent) => {
      const p = posRef.current;
      const c = currentRef.current;
      if (e.key === 'ArrowLeft' && isValid(gridRef.current, c.shape, p.row, p.col - 1)) {
        e.preventDefault();
        setPos(prev => ({ ...prev, col: prev.col - 1 }));
      } else if (e.key === 'ArrowRight' && isValid(gridRef.current, c.shape, p.row, p.col + 1)) {
        e.preventDefault();
        setPos(prev => ({ ...prev, col: prev.col + 1 }));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        drop();
      } else if (e.key === 'ArrowUp' || e.key === ' ') {
        e.preventDefault();
        const rotated = rotate(c.shape);
        if (isValid(gridRef.current, rotated, p.row, p.col)) {
          setCurrent({ ...c, shape: rotated });
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [phase, drop]);

  const start = () => {
    const g = createGrid();
    setGrid(g);
    gridRef.current = g;
    const p = randomPiece();
    setCurrent(p);
    currentRef.current = p;
    setNext(randomPiece());
    setPos({ row: 0, col: 3 });
    setScore(0);
    setLines(0);
    setLevel(1);
    setPhase('playing');
  };

  const handleTouch = (action: 'left' | 'right' | 'down' | 'rotate') => {
    const p = posRef.current;
    const c = currentRef.current;
    if (action === 'left' && isValid(gridRef.current, c.shape, p.row, p.col - 1)) {
      setPos(prev => ({ ...prev, col: prev.col - 1 }));
    } else if (action === 'right' && isValid(gridRef.current, c.shape, p.row, p.col + 1)) {
      setPos(prev => ({ ...prev, col: prev.col + 1 }));
    } else if (action === 'down') {
      drop();
    } else if (action === 'rotate') {
      const rotated = rotate(c.shape);
      if (isValid(gridRef.current, rotated, p.row, p.col)) {
        setCurrent({ ...c, shape: rotated });
      }
    }
  };

  // Build display grid
  const displayGrid = grid.map(r => [...r]);
  if (phase === 'playing') {
    for (let r = 0; r < current.shape.length; r++) {
      for (let c = 0; c < current.shape[r].length; c++) {
        if (current.shape[r][c] && pos.row + r >= 0 && pos.row + r < ROWS) {
          displayGrid[pos.row + r][pos.col + c] = current.color;
        }
      }
    }
  }

  return (
    <div ref={ref} className="flex flex-col items-center gap-3 py-4">
      <div className="text-center">
        <div className="text-4xl mb-2">🧱</div>
        <h2 className="text-lg font-bold">Tetris</h2>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>Score : {score}</span>
        <span>Lignes : {lines}</span>
        <span>Niveau : {level}</span>
      </div>

      <div className="flex gap-3 items-start">
        <div className="rounded-xl overflow-hidden border-2 border-border bg-background/50 p-[1px]">
          <div className="grid" style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}>
            {displayGrid.map((row, ri) =>
              row.map((cell, ci) => (
                <div
                  key={`${ri}-${ci}`}
                  className={cn(
                    'w-5 h-5 sm:w-6 sm:h-6 rounded-[2px] border border-transparent',
                    cell || ((ri + ci) % 2 === 0 ? 'bg-muted/15' : 'bg-muted/5'),
                    cell && `${cell} border-white/10`
                  )}
                />
              ))
            )}
          </div>
        </div>

        {/* Next piece preview */}
        <div className="flex flex-col gap-2">
          <p className="text-[10px] font-semibold text-muted-foreground text-center">Suivant</p>
          <div className="w-16 h-16 rounded-lg bg-muted/20 border border-border flex items-center justify-center">
            <div className="grid gap-[1px]" style={{ gridTemplateColumns: `repeat(${next.shape[0].length}, minmax(0, 1fr))` }}>
              {next.shape.map((row, ri) =>
                row.map((cell, ci) => (
                  <div
                    key={`${ri}-${ci}`}
                    className={cn(
                      'w-3 h-3 rounded-[1px]',
                      cell ? `${next.color}` : 'bg-transparent'
                    )}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {phase !== 'playing' && (
        <div className="text-center">
          {phase === 'over' && (
            <p className="text-sm text-red-400 font-bold mb-2">Game Over — Score : {score}</p>
          )}
          <Button onClick={start} size="sm">
            {phase === 'idle' ? <><Play className="w-4 h-4 mr-2" /> Jouer</> : <><RotateCcw className="w-4 h-4 mr-2" /> Rejouer</>}
          </Button>
        </div>
      )}

      {/* Touch controls */}
      {phase === 'playing' && (
        <div className="flex gap-2 sm:hidden">
          <Button size="icon" variant="outline" className="h-10 w-10" onClick={() => handleTouch('left')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="outline" className="h-10 w-10" onClick={() => handleTouch('rotate')}>
            <RotateCw className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="outline" className="h-10 w-10" onClick={() => handleTouch('down')}>
            <ArrowDown className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="outline" className="h-10 w-10" onClick={() => handleTouch('right')}>
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">← → déplacer • ↑ tourner • ↓ accélérer</p>
    </div>
  );
});

TetrisGame.displayName = 'TetrisGame';
export default TetrisGame;