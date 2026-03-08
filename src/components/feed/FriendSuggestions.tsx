import { Link } from 'react-router-dom';
import { UserPlus, MapPin, Users } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { useSendFriendRequest } from '@/hooks/useFriendships';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

interface Suggestion {
  user_id: string;
  name: string;
  avatar_url: string | null;
  bio: string | null;
  city: string | null;
  mutual_friends_count: number;
}

export function FriendSuggestions() {
  const { user } = useAuth();
  const { data: myProfile } = useProfile();
  const sendRequest = useSendFriendRequest();

  const { data: suggestions, isLoading } = useQuery({
    queryKey: ['friend-suggestions', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase.rpc('get_friend_suggestions', {
        target_user_id: user.id,
        limit_count: 10,
      });
      if (error) throw error;
      return (data || []) as Suggestion[];
    },
    enabled: !!user,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });

  if (isLoading || !suggestions || suggestions.length === 0) return null;

  const isSameCity = (city: string | null) =>
    !!myProfile?.city && !!city && city.toLowerCase().trim() === myProfile.city.toLowerCase().trim();

  return (
    <article className="bg-card border border-border/20 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
            <UserPlus className="w-4 h-4 text-primary" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">Suggestions d'amis</h3>
        </div>
        <Link to="/friends" className="text-xs text-primary font-medium hover:text-primary/80 transition-colors">
          Voir tout
        </Link>
      </div>

      <div className="px-4 pb-4">
        <ScrollArea className="w-full whitespace-nowrap">
          <div className="flex gap-2.5 pb-1">
            {suggestions.map((s) => (
              <div
                key={s.user_id}
                className="flex-shrink-0 w-[130px] rounded-xl border border-border/30 bg-secondary/20 p-3 flex flex-col items-center gap-2 text-center"
              >
                <Link to={`/profile/${s.user_id}`}>
                  <UserAvatar src={s.avatar_url} alt={s.name} size="lg" />
                </Link>
                <Link to={`/profile/${s.user_id}`} className="w-full">
                  <p className="text-xs font-medium truncate w-full text-foreground">{s.name}</p>
                </Link>

                <div className="flex flex-col gap-0.5 w-full">
                  {s.mutual_friends_count > 0 && (
                    <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                      <Users className="w-3 h-3" />
                      {s.mutual_friends_count} en commun
                    </p>
                  )}
                  {isSameCity(s.city) && (
                    <p className="text-[10px] text-primary flex items-center justify-center gap-1">
                      <MapPin className="w-3 h-3" />
                      Même ville
                    </p>
                  )}
                </div>

                <Button
                  size="sm"
                  className="w-full h-7 text-[10px] rounded-lg"
                  onClick={() => sendRequest.mutate(s.user_id)}
                  disabled={sendRequest.isPending}
                >
                  <UserPlus className="w-3 h-3 mr-1" />
                  Ajouter
                </Button>
              </div>
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    </article>
  );
}
