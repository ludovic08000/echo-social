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
  });

  if (isLoading || !suggestions || suggestions.length === 0) return null;

  const isSameCity = (city: string | null) =>
    !!myProfile?.city && !!city && city.toLowerCase().trim() === myProfile.city.toLowerCase().trim();

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Suggestions d'amis</h3>
        <Link to="/friends" className="text-xs text-primary font-medium">
          Voir tout
        </Link>
      </div>
      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex gap-3 pb-2">
          {suggestions.map((s) => (
            <div
              key={s.user_id}
              className="flex-shrink-0 w-36 bg-card rounded-xl border border-border p-3 flex flex-col items-center gap-2 text-center"
            >
              <Link to={`/profile/${s.user_id}`}>
                <UserAvatar src={s.avatar_url} alt={s.name} size="lg" />
              </Link>
              <Link to={`/profile/${s.user_id}`} className="w-full">
                <p className="text-xs font-medium truncate w-full">{s.name}</p>
              </Link>

              {/* Reason tags */}
              <div className="flex flex-col gap-0.5 w-full">
                {s.mutual_friends_count > 0 && (
                  <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                    <Users className="w-3 h-3" />
                    {s.mutual_friends_count} ami{s.mutual_friends_count > 1 ? 's' : ''} en commun
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
                className="w-full h-7 text-xs"
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
  );
}
