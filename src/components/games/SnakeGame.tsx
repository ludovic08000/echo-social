import { useState, useEffect, useCallback, useRef, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Play, RotateCcw, ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from 'lucide-react';

const GRID = 20;
const SPEED_MS = 120;

type Pos = [number, number];
type Dir = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

function randomFood(snake: Pos[]): Pos {
  let pos: Pos;
  do {
    pos = [Math.floor(Math.random() * GRID), Math.floor(Math.random() * GRID)];
  } while (snake.some(([r, c]) => r === pos[0] && c === pos[1]));
  return pos;
}

const SnakeGame = forwardRef<HTMLDivElement>((_, ref) => {
  const [snake, setSnake] = useState<Pos[]>([[10, 10]]);
  const [food, setFood] = useState<Pos>([5, 5]);
  const [dir, setDir] = useState<Dir>('RIGHT');
  const [phase, setPhase] = useState<'idle' | 'playing' | 'over'>('idle');
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const dirRef = useRef(dir);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const move = useCallback(() => {
    setSnake(prev => {
      const head = prev[0];
      const d = dirRef.current;
      const newHead: Pos = [
        d === 'UP' ? head[0] - 1 : d === 'DOWN' ? head[0] + 1 : head[0],
        d === 'LEFT' ? head[1] - 1 : d === 'RIGHT' ? head[1] + 1 : head[1],
      ];

      // Wall collision
      if (newHead[0] < 0 || newHead[0] >= GRID || newHead[1] < 0 || newHead[1] >= GRID) {
        setPhase('over');
        return prev;
      }

      // Self collision
      if (prev.some(([r, c]) => r === newHead[0] && c === newHead[1])) {
        setPhase('over');
        return prev;
      }

      const newSnake = [newHead, ...prev];

      // Eat food
      if (newHead[0] === food[0] && newHead[1] === food[1]) {
        setScore(s => {
          const ns = s + 10;
          setHighScore(h => Math.max(h, ns));
          return ns;
        });
        setFood(randomFood(newSnake));
      } else {
        newSnake.pop();
      }

      return newSnake;
    });
  }, [food]);

  useEffect(() => {
    if (phase !== 'playing') {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(move, SPEED_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [phase, move]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const map: Record<string, Dir> = {
        ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
        w: 'UP', s: 'DOWN', a: 'LEFT', d: 'RIGHT',
      };
      const nd = map[e.key];
      if (!nd) return;
      e.preventDefault();
      const opposite: Record<Dir, Dir> = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };
      if (nd !== opposite[dirRef.current]) {
        dirRef.current = nd;
        setDir(nd);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const start = () => {
    setSnake([[10, 10]]);
    setFood(randomFood([[10, 10]]));
    dirRef.current = 'RIGHT';
    setDir('RIGHT');
    setScore(0);
    setPhase('playing');
  };

  const handleTouch = (d: Dir) => {
    const opposite: Record<Dir, Dir> = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };
    if (d !== opposite[dirRef.current]) {
      dirRef.current = d;
      setDir(d);
    }
  };

  const cellSize = 'w-3.5 h-3.5 sm:w-4 sm:h-4';

  return (
    <div ref={ref} className="flex flex-col items-center gap-4 py-4">
      <div className="text-center">
        <div className="text-4xl mb-2">🐍</div>
        <h2 className="text-lg font-bold">Snake</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Score : {score} {highScore > 0 && `• Record : ${highScore}`}
        </p>
      </div>

      <div className="relative rounded-xl overflow-hidden border-2 border-border bg-background/50 p-[2px]">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${GRID}, minmax(0, 1fr))` }}>
          {Array.from({ length: GRID * GRID }, (_, i) => {
            const r = Math.floor(i / GRID);
            const c = i % GRID;
            const isSnake = snake.some(([sr, sc]) => sr === r && sc === c);
            const isHead = snake[0][0] === r && snake[0][1] === c;
            const isFood = food[0] === r && food[1] === c;
            return (
              <div
                key={i}
                className={cn(
                  cellSize, 'rounded-[2px] transition-colors duration-75',
                  isHead && 'bg-green-400 rounded-md',
                  isSnake && !isHead && 'bg-green-500/70',
                  isFood && 'flex items-center justify-center',
                  !isSnake && !isFood && ((r + c) % 2 === 0 ? 'bg-muted/20' : 'bg-muted/10'),
                )}
              >
                {isFood && <span className="text-[10px]">🍎</span>}
              </div>
            );
          })}
        </div>

        {phase !== 'playing' && (
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
            {phase === 'over' && (
              <div className="text-center">
                <p className="text-lg font-bold text-red-400">Game Over</p>
                <p className="text-sm text-muted-foreground">Score : {score}</p>
              </div>
            )}
            <Button onClick={start} size="sm">
              {phase === 'idle' ? <><Play className="w-4 h-4 mr-2" /> Jouer</> : <><RotateCcw className="w-4 h-4 mr-2" /> Rejouer</>}
            </Button>
          </div>
        )}
      </div>

      {/* Touch controls */}
      {phase === 'playing' && (
        <div className="grid grid-cols-3 gap-1 w-28 sm:hidden">
          <div />
          <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => handleTouch('UP')}>
            <ArrowUp className="w-4 h-4" />
          </Button>
          <div />
          <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => handleTouch('LEFT')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div />
          <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => handleTouch('RIGHT')}>
            <ArrowRight className="w-4 h-4" />
          </Button>
          <div />
          <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => handleTouch('DOWN')}>
            <ArrowDown className="w-4 h-4" />
          </Button>
          <div />
        </div>
      )}

      <p className="text-xs text-muted-foreground">Flèches ou WASD pour diriger</p>
    </div>
  );
});

SnakeGame.displayName = 'SnakeGame';
export default SnakeGame;