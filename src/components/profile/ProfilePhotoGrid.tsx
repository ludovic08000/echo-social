import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Image, Play } from 'lucide-react';

interface ProfilePhotoGridProps {
  userId: string;
  activeTab: string;
}

export function ProfilePhotoGrid({ userId, activeTab }: ProfilePhotoGridProps) {
  // Fetch user's photos (posts with images)
  const { data: photos } = useQuery({
    queryKey: ['profile-photos', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('posts')
        .select('id, image_url, created_at')
        .eq('user_id', userId)
        .not('image_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
    enabled: !!userId && (activeTab === 'photos' || activeTab === 'all'),
  });

  // Fetch user's videos
  const { data: videos } = useQuery({
    queryKey: ['profile-videos', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('short_videos')
        .select('id, thumbnail_url, view_count, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
    enabled: !!userId && (activeTab === 'reels' || activeTab === 'all'),
  });

  if (activeTab === 'photos') {
    if (!photos || photos.length === 0) {
      return (
        <div className="p-8 text-center text-muted-foreground">
          <Image className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Aucune photo</p>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-3 gap-1">
        {photos.map((photo) => (
          <Link
            key={photo.id}
            to={`/post/${photo.id}`}
            className="aspect-square bg-muted overflow-hidden group"
          >
            <img
              src={photo.image_url!}
              alt=""
              className="w-full h-full object-cover group-hover:scale-105 transition-transform"
            />
          </Link>
        ))}
      </div>
    );
  }

  if (activeTab === 'reels') {
    if (!videos || videos.length === 0) {
      return (
        <div className="p-8 text-center text-muted-foreground">
          <Play className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Aucune vidéo</p>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-3 gap-1">
        {videos.map((video) => (
          <Link
            key={video.id}
            to="/videos"
            className="aspect-[9/16] bg-muted overflow-hidden group relative"
          >
            {video.thumbnail_url ? (
              <img
                src={video.thumbnail_url}
                alt=""
                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-primary/10 to-accent/20 flex items-center justify-center">
                <Play className="w-8 h-8 text-muted-foreground" />
              </div>
            )}
            <div className="absolute bottom-1 left-1 flex items-center gap-1 text-white text-[10px]">
              <Play className="w-3 h-3 fill-current" />
              <span>{formatCount(video.view_count)}</span>
            </div>
          </Link>
        ))}
      </div>
    );
  }

  // Tab "all" - show summary of photos and videos
  return null;
}

function formatCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}
