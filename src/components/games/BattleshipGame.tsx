import { useState, useCallback, forwardRef } from 'react';
import GameWrapper from './GameWrapper';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Anchor, Crosshair, RotateCcw } from 'lucide-react';

type Cell = 'empty' | 'ship' | 'hit' | 'miss' | 'sunk';
type Ship = { name: string; size: number; emoji: string };

const SHIPS: Ship[] = [
  { name: 'Porte-avions', size: 5, emoji: '🚢' },
  { name: 'Croiseur', size: 4, emoji: '⛴️' },
  { name: 'Destroyer', size: 3, emoji: '🛥️' },
  { name: 'Sous-marin', size: 3, emoji: '🐟' },
  { name: 'Patrouilleur', size: 2, emoji: '🛶' },
];

const SIZE = 10;

type PlacedShip = { ship: Ship; cells: [number, number][]; sunk: boolean };

function createEmptyGrid(): Cell[][] {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill('empty'));
}

function canPlace(grid: Cell[][], row: number, col: number, size: number, horizontal: boolean): boolean {
  for (let i = 0; i < size; i++) {
    const r = horizontal ? row : row + i;
    const c = horizontal ? col + i : col;
    if (r >= SIZE || c >= SIZE || grid[r][c] !== 'empty') return false;
  }
  return true;
}

function placeShipOnGrid(grid: Cell[][], row: number, col: number, size: number, horizontal: boolean): [number, number][] {
  const cells: [number, number][] = [];
  for (let i = 0; i < size; i++) {
    const r = horizontal ? row : row + i;
    const c = horizontal ? col + i : col;
    grid[r][c] = 'ship';
    cells.push([r, c]);
  }
  return cells;
}

function autoPlace(grid: Cell[][], ships: Ship[]): PlacedShip[] {
  const placed: PlacedShip[] = [];
  for (const ship of ships) {
    let attempts = 0;
    while (attempts < 200) {
      const horizontal = Math.random() > 0.5;
      const row = Math.floor(Math.random() * SIZE);
      const col = Math.floor(Math.random() * SIZE);
      if (canPlace(grid, row, col, ship.size, horizontal)) {
        const cells = placeShipOnGrid(grid, row, col, ship.size, horizontal);
        placed.push({ ship, cells, sunk: false });
        break;
      }
      attempts++;
    }
  }
  return placed;
}

function checkSunk(shipCells: [number, number][], grid: Cell[][]): boolean {
  return shipCells.every(([r, c]) => grid[r][c] === 'hit' || grid[r][c] === 'sunk');
}

const BattleshipGame = forwardRef<HTMLDivElement>((_, ref) => {
  const [phase, setPhase] = useState<'playing' | 'won' | 'lost'>('playing');
  const [playerAttackGrid, setPlayerAttackGrid] = useState(createEmptyGrid);
  const [aiAttackGrid, setAiAttackGrid] = useState(createEmptyGrid);

  const [playerGrid] = useState(() => {
    const g = createEmptyGrid();
    return g;
  });
  const [playerShips] = useState(() => autoPlace(playerGrid, SHIPS));

  const [aiGrid] = useState(() => {
    const g = createEmptyGrid();
    return g;
  });
  const [aiShips] = useState(() => autoPlace(aiGrid, SHIPS));

  const [playerSunk, setPlayerSunk] = useState(0);
  const [aiSunk, setAiSunk] = useState(0);
  const [turn, setTurn] = useState<'player' | 'ai'>('player');

  const aiAttack = useCallback(() => {
    const available: [number, number][] = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (aiAttackGrid[r][c] === 'empty' || aiAttackGrid[r][c] === 'ship') {
          available.push([r, c]);
        }
      }
    }
    if (available.length === 0) return;

    const [ar, ac] = available[Math.floor(Math.random() * available.length)];
    const newAiAttack = aiAttackGrid.map(row => [...row]);

    const isShip = playerGrid[ar][ac] === 'ship';
    newAiAttack[ar][ac] = isShip ? 'hit' : 'miss';

    if (isShip) {
      let sunkCount = aiSunk;
      for (const ps of playerShips) {
        if (!ps.sunk && checkSunk(ps.cells, newAiAttack)) {
          ps.sunk = true;
          ps.cells.forEach(([sr, sc]) => { newAiAttack[sr][sc] = 'sunk'; });
          sunkCount++;
        }
      }
      setAiSunk(sunkCount);
      if (sunkCount >= SHIPS.length) {
        setPhase('lost');
      }
    }

    setAiAttackGrid(newAiAttack);
    setTurn('player');
  }, [aiAttackGrid, playerGrid, playerShips, aiSunk]);

  const handlePlayerAttack = useCallback((row: number, col: number) => {
    if (phase !== 'playing' || turn !== 'player') return;
    if (playerAttackGrid[row][col] !== 'empty') return;

    const newAttack = playerAttackGrid.map(r => [...r]);
    const isShip = aiGrid[row][col] === 'ship';
    newAttack[row][col] = isShip ? 'hit' : 'miss';

    if (isShip) {
      let sunkCount = playerSunk;
      for (const as2 of aiShips) {
        if (!as2.sunk && checkSunk(as2.cells, newAttack)) {
          as2.sunk = true;
          as2.cells.forEach(([sr, sc]) => { newAttack[sr][sc] = 'sunk'; });
          sunkCount++;
        }
      }
      setPlayerSunk(sunkCount);
      if (sunkCount >= SHIPS.length) {
        setPhase('won');
      }
    }

    setPlayerAttackGrid(newAttack);
    setTurn('ai');

    if (phase === 'playing') {
      setTimeout(aiAttack, 600);
    }
  }, [phase, turn, playerAttackGrid, aiGrid, aiShips, playerSunk, aiAttack]);

  const reset = () => {
    window.location.reload();
  };

  const renderGrid = (grid: Cell[][], onClick?: (r: number, c: number) => void, showShips?: boolean, baseGrid?: Cell[][]) => (
    <div className="grid grid-cols-10 gap-[2px]">
      {grid.map((row, ri) =>
        row.map((cell, ci) => {
          const actual = showShips && baseGrid ? baseGrid[ri][ci] : 'empty';
          const display = cell === 'empty' && actual === 'ship' && showShips ? 'ship' : cell;
          return (
            <button
              key={`${ri}-${ci}`}
              onClick={() => onClick?.(ri, ci)}
              disabled={!onClick || cell !== 'empty'}
              className={cn(
                'w-7 h-7 sm:w-8 sm:h-8 rounded-sm text-[10px] font-bold transition-all',
                display === 'empty' && 'bg-muted/40 hover:bg-primary/20',
                display === 'ship' && 'bg-blue-500/30',
                display === 'hit' && 'bg-red-500 text-white',
                display === 'miss' && 'bg-muted/80',
                display === 'sunk' && 'bg-red-700 text-white',
                onClick && cell === 'empty' && 'cursor-crosshair'
              )}
            >
              {display === 'hit' ? '💥' : display === 'miss' ? '•' : display === 'sunk' ? '🔥' : display === 'ship' ? '▪' : ''}
            </button>
          );
        })
      )}
    </div>
  );

  return (
    <div ref={ref} className="flex flex-col items-center gap-4 py-4">
      <div className="text-center">
        <div className="text-4xl mb-2">⚓</div>
        <h2 className="text-lg font-bold">Bataille Navale</h2>
        {phase === 'playing' && (
          <p className="text-sm text-muted-foreground mt-1">
            {turn === 'player' ? '🎯 Votre tour — cliquez pour attaquer' : '⏳ L\'IA réfléchit...'}
          </p>
        )}
        {phase === 'won' && <p className="text-sm text-green-400 font-bold mt-1">🏆 Victoire !</p>}
        {phase === 'lost' && <p className="text-sm text-red-400 font-bold mt-1">💀 Défaite !</p>}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Vos bateaux coulés : {aiSunk}/{SHIPS.length}</span>
        <span>•</span>
        <span>Bateaux ennemis coulés : {playerSunk}/{SHIPS.length}</span>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-start">
        <div>
          <p className="text-xs font-semibold text-center mb-1.5 flex items-center justify-center gap-1">
            <Crosshair className="w-3 h-3" /> Grille ennemie
          </p>
          {renderGrid(playerAttackGrid, phase === 'playing' && turn === 'player' ? handlePlayerAttack : undefined)}
        </div>
        <div>
          <p className="text-xs font-semibold text-center mb-1.5 flex items-center justify-center gap-1">
            <Anchor className="w-3 h-3" /> Votre flotte
          </p>
          {renderGrid(aiAttackGrid, undefined, true, playerGrid)}
        </div>
      </div>

      {phase !== 'playing' && (
        <Button onClick={reset} size="sm" className="mt-2">
          <RotateCcw className="w-4 h-4 mr-2" /> Rejouer
        </Button>
      )}
    </div>
  );
});

BattleshipGame.displayName = 'BattleshipGame';
export default BattleshipGame;