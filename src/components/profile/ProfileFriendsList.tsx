import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { UserAvatar } from '@/components/UserAvatar';
import { FriendshipButton } from '@/components/FriendshipButton';
import { useAuth } from '@/lib/auth';

interface ProfileFriend {
  user_id: string;
  name: string;
  avatar_url: string | null;
}

export function ProfileFriendsList({ userId }: { userId: string }) {
  const { user } = useAuth();

  const { data: friends, isLoading } = useQuery({
    queryKey: ['profile-friends', userId],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_visible_profile_friends', {
        p_user_id: userId,
        p_limit: 60,
      });
      if (error) throw error;
      return (data || []) as ProfileFriend[];
    },
    enabled: !!userId,
  });

  if (isLoading) {
    return (
      <div className="premium-card p-4">
        <div className="animate-pulse grid grid-cols-3 gap-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="flex flex-col items-center gap-2">
              <div className="w-16 h-16 rounded-xl bg-muted" />
              <div className="h-3 w-14 bg-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!friends || friends.length === 0) {
    return (
      <div className="premium-card p-5 text-center">
        <p className="text-sm text-muted-foreground">Aucun ami pour le moment</p>
      </div>
    );
  }

  return (
    <div className="premium-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Amis</h3>
        {user?.id === userId && (
          <Link to="/friends" className="text-xs text-primary font-medium hover:underline">
            Gérer
          </Link>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {friends.map(friend => (
          <div key={friend.user_id} className="flex flex-col items-center gap-1.5">
            <Link to={`/profile/${friend.user_id}`} className="group">
              <div className="w-full aspect-square rounded-xl overflow-hidden bg-muted">
                <UserAvatar
                  src={friend.avatar_url}
                  alt={friend.name}
                  size="xl"
                  className="w-full h-full rounded-xl"
                />
              </div>
            </Link>
            <Link to={`/profile/${friend.user_id}`}>
              <p className="text-xs font-medium text-center truncate w-full hover:underline">
                {friend.name}
              </p>
            </Link>
            {user && user.id !== friend.user_id && (
              <FriendshipButton userId={friend.user_id} showMessage={false} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
