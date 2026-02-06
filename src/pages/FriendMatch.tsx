import { useState, useMemo } from 'react';
import { ArrowLeft, X, Heart, MapPin, Users, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/UserAvatar';
import { useFriendSuggestions } from '@/hooks/useFriendMatch';
import { useSendFriendRequest } from '@/hooks/useFriendships';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

export default function FriendMatch() {
  const navigate = useNavigate();
  const { data: suggestions, isLoading, refetch } = useFriendSuggestions(20);
  const sendRequest = useSendFriendRequest();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [direction, setDirection] = useState<'left' | 'right' | null>(null);

  const remaining = useMemo(() => 
    suggestions?.filter(s => !skipped.has(s.user_id)) || [],
  [suggestions, skipped]);

  const current = remaining[currentIndex] || null;

  const handleSkip = () => {
    if (!current) return;
    setDirection('left');
    setTimeout(() => {
      setSkipped(prev => new Set(prev).add(current.user_id));
      setDirection(null);
    }, 200);
  };

  const handleConnect = async () => {
    if (!current) return;
    setDirection('right');
    try {
      await sendRequest.mutateAsync(current.user_id);
      toast({ title: '🤝 Demande envoyée !', description: `Vous avez invité ${current.name}` });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
    setTimeout(() => {
      setSkipped(prev => new Set(prev).add(current.user_id));
      setDirection(null);
    }, 200);
  };

  return (
    <AppLayout>
      <div className="px-4 py-2">
        <header className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-8 w-8 rounded-full">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h1 className="text-lg font-bold">🤝 Matchmaking</h1>
          </div>
          <Button variant="ghost" size="icon" onClick={() => { refetch(); setCurrentIndex(0); setSkipped(new Set()); }} className="h-8 w-8 rounded-full">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </header>

        {isLoading ? (
          <div className="premium-card p-8 animate-pulse">
            <div className="w-24 h-24 rounded-full bg-muted mx-auto" />
            <div className="h-5 w-32 bg-muted rounded mx-auto mt-4" />
            <div className="h-3 w-48 bg-muted rounded mx-auto mt-2" />
          </div>
        ) : !current ? (
          <div className="premium-card p-10 text-center">
            <Users className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Plus de suggestions pour le moment</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Revenez plus tard !</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => { refetch(); setCurrentIndex(0); setSkipped(new Set()); }}>
              <RefreshCw className="w-4 h-4 mr-1" /> Rafraîchir
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center">
            {/* Card */}
            <div className={cn(
              "premium-card p-6 w-full max-w-sm transition-all duration-200",
              direction === 'left' && "translate-x-[-100%] opacity-0 rotate-[-10deg]",
              direction === 'right' && "translate-x-[100%] opacity-0 rotate-[10deg]",
            )}>
              <div className="flex flex-col items-center text-center">
                <UserAvatar src={current.avatar_url} alt={current.name} size="xl" className="w-24 h-24" />
                <h2 className="text-xl font-bold mt-4">{current.name}</h2>
                {current.city && (
                  <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                    <MapPin className="w-3.5 h-3.5" /> {current.city}
                  </p>
                )}
                {current.bio && (
                  <p className="text-sm text-muted-foreground mt-3 leading-relaxed">{current.bio}</p>
                )}
                {current.mutual_friends_count > 0 && (
                  <p className="text-xs text-primary font-medium mt-3 flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" />
                    {current.mutual_friends_count} ami{current.mutual_friends_count > 1 ? 's' : ''} en commun
                  </p>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-6 mt-8">
              <button
                onClick={handleSkip}
                className="w-16 h-16 rounded-full border-2 border-border flex items-center justify-center hover:border-destructive hover:bg-destructive/10 transition-all active:scale-90"
              >
                <X className="w-7 h-7 text-muted-foreground" />
              </button>
              <button
                onClick={() => navigate(`/profile/${current.user_id}`)}
                className="w-12 h-12 rounded-full border-2 border-border flex items-center justify-center hover:border-primary hover:bg-primary/10 transition-all text-xs font-medium text-muted-foreground"
              >
                Profil
              </button>
              <button
                onClick={handleConnect}
                disabled={sendRequest.isPending}
                className="w-16 h-16 rounded-full bg-premium-gradient flex items-center justify-center shadow-premium-gold hover:scale-105 transition-all active:scale-90"
              >
                <Heart className="w-7 h-7 text-primary-foreground" />
              </button>
            </div>

            <p className="text-xs text-muted-foreground/60 mt-4">
              {remaining.length - 1} suggestion{remaining.length - 1 > 1 ? 's' : ''} restante{remaining.length - 1 > 1 ? 's' : ''}
            </p>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
