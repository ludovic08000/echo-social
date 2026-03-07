import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus, MapPin, Users, ChevronRight, Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useSendFriendRequest } from '@/hooks/useFriendships';
import { motion } from 'framer-motion';

interface Suggestion {
  user_id: string;
  name: string;
  avatar_url: string | null;
  bio: string | null;
  city: string | null;
  profile_type: string | null;
  mutual_friends_count: number;
}

export function FriendSuggestionsByCity() {
  const { user } = useAuth();
  const { data: myProfile } = useProfile();
  const sendRequest = useSendFriendRequest();
  const [sentRequests, setSentRequests] = useState<Set<string>>(new Set());

  const { data: suggestions, isLoading } = useQuery({
    queryKey: ['friend-suggestions-city', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase.rpc('get_friend_suggestions', {
        target_user_id: user.id,
        limit_count: 30,
      });
      if (error) throw error;
      return (data || []) as Suggestion[];
    },
    enabled: !!user,
  });

  // Group by city
  const grouped = useMemo(() => {
    if (!suggestions) return {};
    const groups: Record<string, Suggestion[]> = {};
    
    // First: same city
    const myCity = myProfile?.city?.toLowerCase().trim();
    
    suggestions.forEach(s => {
      const city = s.city?.trim() || 'Autre';
      if (!groups[city]) groups[city] = [];
      groups[city].push(s);
    });

    // Sort: own city first
    const sorted: [string, Suggestion[]][] = Object.entries(groups).sort(([a], [b]) => {
      if (myCity && a.toLowerCase() === myCity) return -1;
      if (myCity && b.toLowerCase() === myCity) return 1;
      return b.length === a.length ? a.localeCompare(b) : 0;
    });

    return Object.fromEntries(sorted);
  }, [suggestions, myProfile?.city]);

  const handleAdd = (userId: string) => {
    sendRequest.mutate(userId);
    setSentRequests(prev => new Set(prev).add(userId));
  };

  if (isLoading || !suggestions || suggestions.length === 0) return null;

  const cities = Object.keys(grouped);

  return (
    <div className="px-4 py-3">
      <div className="premium-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
              <Sparkles className="w-4.5 h-4.5 text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground">Personnes à découvrir</h3>
              <p className="text-[10px] text-muted-foreground">Suggestions par ville et région</p>
            </div>
          </div>
          <Link to="/friends" className="text-xs text-primary font-medium flex items-center gap-0.5">
            Voir tout <ChevronRight className="w-3 h-3" />
          </Link>
        </div>

        {cities.slice(0, 3).map((city) => (
          <div key={city} className="space-y-2.5">
            <div className="flex items-center gap-2">
              <MapPin className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-semibold text-foreground">{city}</span>
              {myProfile?.city?.toLowerCase().trim() === city.toLowerCase().trim() && (
                <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 bg-primary/10 text-primary border-primary/20">
                  Votre ville
                </Badge>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto">{grouped[city].length} personne{grouped[city].length > 1 ? 's' : ''}</span>
            </div>

            <div className="space-y-1.5">
              {grouped[city].slice(0, 3).map((s, i) => (
                <motion.div
                  key={s.user_id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="flex items-center gap-3 p-2 rounded-xl hover:bg-secondary/40 transition-colors group"
                >
                  <Link to={`/profile/${s.user_id}`} className="shrink-0">
                    <UserAvatar src={s.avatar_url} alt={s.name} size="md" />
                  </Link>
                  <div className="flex-1 min-w-0">
                    <Link to={`/profile/${s.user_id}`}>
                      <p className="text-xs font-semibold text-foreground truncate hover:text-primary transition-colors">{s.name}</p>
                    </Link>
                    <div className="flex items-center gap-2 mt-0.5">
                      {s.mutual_friends_count > 0 && (
                        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                          <Users className="w-2.5 h-2.5" /> {s.mutual_friends_count} en commun
                        </span>
                      )}
                      {s.bio && (
                        <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">{s.bio}</span>
                      )}
                    </div>
                  </div>
                  {sentRequests.has(s.user_id) ? (
                    <Badge variant="secondary" className="text-[10px] px-2 py-0.5 bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
                      Envoyé ✓
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      className="h-7 text-[10px] gap-1 rounded-lg opacity-80 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleAdd(s.user_id)}
                      disabled={sendRequest.isPending}
                    >
                      <UserPlus className="w-3 h-3" /> Ajouter
                    </Button>
                  )}
                </motion.div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
