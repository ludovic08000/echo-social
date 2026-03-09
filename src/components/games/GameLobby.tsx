import { useState, forwardRef } from 'react';
import { Bot, Users, Swords, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFriendships } from '@/hooks/useFriendships';
import { UserAvatar } from '@/components/UserAvatar';
import { cn } from '@/lib/utils';

export type GameMode = 'ai' | 'local' | 'friend';
export type AIDifficulty = 'easy' | 'medium' | 'hard';

interface GameLobbyProps {
  gameName: string;
  gameIcon: string;
  onStart: (mode: GameMode, difficulty?: AIDifficulty, friendId?: string, friendName?: string) => void;
}

const GameLobby = forwardRef<HTMLDivElement, GameLobbyProps>(function GameLobby({ gameName, gameIcon, onStart }, ref) {
  const [step, setStep] = useState<'mode' | 'difficulty' | 'friend'>('mode');
  const { data: friendsData, isLoading } = useFriendships();

  const friends = friendsData?.friends || [];
  const [step, setStep] = useState<'mode' | 'difficulty' | 'friend'>('mode');
  const { data: friendsData, isLoading } = useFriendships();

  const friends = friendsData?.friends || [];

  return (
    <div ref={ref} className="flex flex-col items-center gap-6 py-6">
      {/* Game title */}
      <div className="text-center">
        <div className="text-5xl mb-3">{gameIcon}</div>
        <h2 className="text-xl font-bold">{gameName}</h2>
        <p className="text-sm text-muted-foreground mt-1">Choisissez votre mode de jeu</p>
      </div>

      {step === 'mode' && (
        <div className="w-full max-w-sm space-y-3">
          <button
            onClick={() => setStep('difficulty')}
            className="group w-full flex items-center gap-4 p-4 rounded-2xl bg-card border border-border hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 active:scale-[0.98]"
          >
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
              <Bot className="w-6 h-6 text-primary" />
            </div>
            <div className="flex-1 text-left">
              <p className="font-semibold text-sm">Contre l'IA</p>
              <p className="text-xs text-muted-foreground">3 niveaux de difficulté</p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
          </button>

          <button
            onClick={() => onStart('local')}
            className="group w-full flex items-center gap-4 p-4 rounded-2xl bg-card border border-border hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 active:scale-[0.98]"
          >
            <div className="w-12 h-12 rounded-xl bg-accent/50 flex items-center justify-center group-hover:bg-accent transition-colors">
              <Swords className="w-6 h-6 text-accent-foreground" />
            </div>
            <div className="flex-1 text-left">
              <p className="font-semibold text-sm">Local (2 joueurs)</p>
              <p className="text-xs text-muted-foreground">Jouez sur le même écran</p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
          </button>

          <button
            onClick={() => setStep('friend')}
            className="group w-full flex items-center gap-4 p-4 rounded-2xl bg-card border border-border hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 active:scale-[0.98]"
          >
            <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center group-hover:bg-secondary/80 transition-colors">
              <Users className="w-6 h-6 text-secondary-foreground" />
            </div>
            <div className="flex-1 text-left">
              <p className="font-semibold text-sm">Contre un ami</p>
              <p className="text-xs text-muted-foreground">Invitez un ami à jouer</p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
          </button>
        </div>
      )}

      {step === 'difficulty' && (
        <div className="w-full max-w-sm space-y-3">
          <button onClick={() => setStep('mode')} className="text-xs text-muted-foreground hover:text-foreground transition-colors mb-2 flex items-center gap-1">
            ← Retour
          </button>
          {([
            { level: 'easy' as AIDifficulty, label: 'Facile', desc: 'IA débutante, idéal pour apprendre', emoji: '🟢', color: 'text-green-400' },
            { level: 'medium' as AIDifficulty, label: 'Moyen', desc: 'IA intermédiaire, un bon défi', emoji: '🟡', color: 'text-yellow-400' },
            { level: 'hard' as AIDifficulty, label: 'Difficile', desc: 'IA experte, préparez-vous !', emoji: '🔴', color: 'text-red-400' },
          ]).map(d => (
            <button
              key={d.level}
              onClick={() => onStart('ai', d.level)}
              className="group w-full flex items-center gap-4 p-4 rounded-2xl bg-card border border-border hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 active:scale-[0.98]"
            >
              <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center text-2xl">
                {d.emoji}
              </div>
              <div className="flex-1 text-left">
                <p className={cn("font-semibold text-sm", d.color)}>{d.label}</p>
                <p className="text-xs text-muted-foreground">{d.desc}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
            </button>
          ))}
        </div>
      )}

      {step === 'friend' && (
        <div className="w-full max-w-sm space-y-3">
          <button onClick={() => setStep('mode')} className="text-xs text-muted-foreground hover:text-foreground transition-colors mb-2 flex items-center gap-1">
            ← Retour
          </button>
          {isLoading ? (
            <div className="text-center py-8 text-sm text-muted-foreground">Chargement...</div>
          ) : friends.length === 0 ? (
            <div className="text-center py-8">
              <Users className="w-10 h-10 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Aucun ami pour le moment</p>
              <p className="text-xs text-muted-foreground mt-1">Ajoutez des amis pour jouer ensemble !</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => onStart('local')}>
                Jouer en local
              </Button>
            </div>
          ) : (
            friends.map(friend => (
              <button
                key={friend.id}
                onClick={() => onStart('friend', undefined, friend.profile.user_id, friend.profile.name)}
                className="group w-full flex items-center gap-3 p-3 rounded-2xl bg-card border border-border hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 active:scale-[0.98]"
              >
                <UserAvatar
                  src={friend.profile.avatar_url}
                  alt={friend.profile.name}
                  size="sm"
                />
                <div className="flex-1 text-left">
                  <p className="font-semibold text-sm">{friend.profile.name}</p>
                </div>
                <span className="text-xs bg-primary/10 text-primary px-2.5 py-1 rounded-full group-hover:bg-primary/20 transition-colors">
                  Inviter
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
});

export default GameLobby;
