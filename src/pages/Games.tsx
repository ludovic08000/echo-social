import { useState } from 'react';
import { ArrowLeft, Gamepad2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ChessGame from '@/components/games/ChessGame';
import CheckersGame from '@/components/games/CheckersGame';
import TicTacToeGame from '@/components/games/TicTacToeGame';
import Connect4Game from '@/components/games/Connect4Game';

const GAMES = [
  { id: 'chess', label: '♟️ Échecs', component: ChessGame },
  { id: 'checkers', label: '🔴 Dames', component: CheckersGame },
  { id: 'tictactoe', label: '❌ Morpion', component: TicTacToeGame },
  { id: 'connect4', label: '🟡 Puissance 4', component: Connect4Game },
];

export default function Games() {
  const navigate = useNavigate();
  const [activeGame, setActiveGame] = useState('chess');

  return (
    <AppLayout>
      <div className="px-4 py-2 max-w-2xl mx-auto">
        <header className="flex items-center gap-3 mb-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-8 w-8 rounded-full">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-2">
            <Gamepad2 className="w-5 h-5 text-primary" />
            <h1 className="text-lg font-bold">Jeux</h1>
          </div>
        </header>

        <Tabs value={activeGame} onValueChange={setActiveGame}>
          <TabsList className="w-full grid grid-cols-4 mb-4 h-auto p-1 rounded-xl">
            {GAMES.map(g => (
              <TabsTrigger key={g.id} value={g.id} className="text-xs py-2 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                {g.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {GAMES.map(g => (
            <TabsContent key={g.id} value={g.id}>
              <g.component />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </AppLayout>
  );
}
