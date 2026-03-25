import { useState } from 'react';
import { ArrowLeft, Gamepad2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import ChessGame from '@/components/games/ChessGame';
import CheckersGame from '@/components/games/CheckersGame';
import TicTacToeGame from '@/components/games/TicTacToeGame';
import Connect4Game from '@/components/games/Connect4Game';
import BattleshipGame from '@/components/games/BattleshipGame';
import MemoryGame from '@/components/games/MemoryGame';
import SnakeGame from '@/components/games/SnakeGame';
import TetrisGame from '@/components/games/TetrisGame';

const GAMES = [
  { id: 'chess', label: '♟️ Échecs', component: ChessGame },
  { id: 'checkers', label: '🔴 Dames', component: CheckersGame },
  { id: 'tictactoe', label: '❌ Morpion', component: TicTacToeGame },
  { id: 'connect4', label: '🟡 P4', component: Connect4Game },
  { id: 'battleship', label: '⚓ Naval', component: BattleshipGame },
  { id: 'memory', label: '🧠 Memory', component: MemoryGame },
  { id: 'snake', label: '🐍 Snake', component: SnakeGame },
  { id: 'tetris', label: '🧱 Tetris', component: TetrisGame },
];

export default function Games() {
  const navigate = useNavigate();
  const [activeGame, setActiveGame] = useState('chess');

  return (
    <AppLayout>
      <div className="px-4 py-2 max-w-2xl mx-auto">
        <header className="flex items-center gap-3 mb-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-9 w-9 rounded-xl">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-2 flex-1">
            <Gamepad2 className="w-5 h-5 text-primary" />
            <h1 className="text-lg font-bold tracking-tight">Jeux</h1>
          </div>
          {/* Zeus game helper */}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-zeus', { detail: { action: 'games' } }))}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold text-primary bg-primary/10 border border-primary/20 hover:bg-primary/15 transition-all duration-200"
          >
            <Sparkles className="w-3 h-3" />
            Zeus
          </button>
        </header>

        <Tabs value={activeGame} onValueChange={setActiveGame}>
          <ScrollArea className="w-full mb-4">
            <TabsList className="inline-flex w-max gap-1 h-auto p-1 rounded-xl bg-secondary/50">
              {GAMES.map(g => (
                <TabsTrigger
                  key={g.id}
                  value={g.id}
                  className="text-xs py-2.5 px-3.5 rounded-lg whitespace-nowrap data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm transition-all duration-200"
                >
                  {g.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
          {GAMES.map(g => (
            <TabsContent key={g.id} value={g.id} className="mt-0 animate-fade-in">
              <g.component />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </AppLayout>
  );
}