import { Link } from 'react-router-dom';
import { Image, Video } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

interface MediaPost {
  id: string;
  image_url: string;
  user_id: string;
  created_at: string;
}

export function FeedMediaSection() {
  const { user } = useAuth();

  const { data: mediaPosts } = useQuery({
    queryKey: ['feed-media', user?.id],
    queryFn: async () => {
      if (!user) return [];

      // Get friends
      const { data: friendships } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

      const friendIds = friendships?.map(f =>
        f.requester_id === user.id ? f.addressee_id : f.requester_id
      ) || [];

      const allowedUserIds = [user.id, ...friendIds];

      const { data, error } = await supabase
        .from('posts')
        .select('id, image_url, user_id, created_at')
        .in('user_id', allowedUserIds)
        .not('image_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) throw error;
      return (data || []) as MediaPost[];
    },
    enabled: !!user,
  });

  if (!mediaPosts || mediaPosts.length === 0) return null;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Image className="w-4 h-4 text-primary" />
          <h3 className="font-semibold text-sm">Photos & Médias récents</h3>
        </div>
      </div>
      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex gap-2 pb-2">
          {mediaPosts.map((post) => (
            <Link
              key={post.id}
              to={`/post/${post.id}`}
              className="flex-shrink-0 w-28 h-28 rounded-xl overflow-hidden bg-muted group"
            >
              <img
                src={post.image_url}
                alt=""
                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
              />
            </Link>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
