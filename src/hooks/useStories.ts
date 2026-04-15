import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface Story {
  id: string;
  user_id: string;
  image_url: string;
  caption: string | null;
  created_at: string;
  expires_at: string;
  profile: {
    name: string;
    avatar_url: string | null;
  };
  views_count: number;
  likes_count: number;
  is_viewed: boolean;
  is_liked: boolean;
}

export interface StoryViewer {
  viewer_id: string;
  viewed_at: string;
  name: string;
  avatar_url: string | null;
}

export interface GroupedStories {
  user_id: string;
  profile: {
    name: string;
    avatar_url: string | null;
  };
  stories: Story[];
  has_unviewed: boolean;
}

export function useStories() {
  const { user, loading } = useAuth();
  const isGuest = !loading && !user;

  return useQuery({
    queryKey: ['stories', loading ? 'loading' : user?.id ?? 'guest'],
    queryFn: async () => {
      if (isGuest) return [];

      const now = new Date().toISOString();

      const { data: stories, error } = await supabase
        .from('stories')
        .select('*')
        .gt('expires_at', now)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const activeStories = stories ?? [];
      if (activeStories.length === 0) {
        return [];
      }

      const userIds = [...new Set(activeStories.map((story) => story.user_id))];
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', userIds);

      if (profilesError) throw profilesError;

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      const storyIds = activeStories.map((story) => story.id);
      const [viewsRes, userViewsRes, likesRes, userLikesRes] = await Promise.all([
        supabase.from('story_views').select('story_id').in('story_id', storyIds),
        user
          ? supabase.from('story_views').select('story_id').eq('viewer_id', user.id).in('story_id', storyIds)
          : Promise.resolve({ data: [] }),
        supabase.from('story_likes').select('story_id').in('story_id', storyIds),
        user
          ? supabase.from('story_likes').select('story_id').eq('user_id', user.id).in('story_id', storyIds)
          : Promise.resolve({ data: [] }),
      ]);

      const viewsCount: Record<string, number> = {};
      const likesCount: Record<string, number> = {};
      const userViews = new Set(userViewsRes.data?.map(v => v.story_id) || []);
      const userLikes = new Set(userLikesRes.data?.map(v => v.story_id) || []);

      viewsRes.data?.forEach(v => {
        viewsCount[v.story_id] = (viewsCount[v.story_id] || 0) + 1;
      });
      likesRes.data?.forEach(v => {
        likesCount[v.story_id] = (likesCount[v.story_id] || 0) + 1;
      });

      const enrichedStories: Story[] = activeStories.map(story => {
        const profile = profileMap.get(story.user_id);
        return {
          ...story,
          profile: {
            name: profile?.name || 'Unknown',
            avatar_url: profile?.avatar_url || null,
          },
          views_count: viewsCount[story.id] || 0,
          likes_count: likesCount[story.id] || 0,
          is_viewed: userViews.has(story.id),
          is_liked: userLikes.has(story.id),
        };
      });

      // Group stories by user
      const grouped: Record<string, GroupedStories> = {};
      
      enrichedStories.forEach(story => {
        if (!grouped[story.user_id]) {
          grouped[story.user_id] = {
            user_id: story.user_id,
            profile: story.profile,
            stories: [],
            has_unviewed: false,
          };
        }
        grouped[story.user_id].stories.push(story);
        if (!story.is_viewed) {
          grouped[story.user_id].has_unviewed = true;
        }
      });

      // Put current user's stories first, then others
      const result = Object.values(grouped);
      if (user) {
        const currentUserIndex = result.findIndex(g => g.user_id === user.id);
        if (currentUserIndex > 0) {
          const [currentUser] = result.splice(currentUserIndex, 1);
          result.unshift(currentUser);
        }
      }

      return result;
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    enabled: !loading,
  });
}

export function useCreateStory() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ imageUrl, caption }: { imageUrl: string; caption?: string }) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('stories')
        .insert({
          user_id: user.id,
          image_url: imageUrl,
          caption: caption?.trim() || null,
        });

      if (error) throw error;
      return { imageUrl };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stories'] });
    },
  });
}

export function useViewStory() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (storyId: string) => {
      if (!user) return;

      const { error } = await supabase
        .from('story_views')
        .upsert({
          story_id: storyId,
          viewer_id: user.id,
        }, { onConflict: 'story_id,viewer_id' });

      if (error && error.code !== '23505') throw error;

      // Get story owner and create notification
      const { data: story } = await supabase
        .from('stories')
        .select('user_id')
        .eq('id', storyId)
        .single();

      if (story && story.user_id !== user.id) {
        try {
          await supabase.from('notifications').insert({
            user_id: story.user_id,
            type: 'story_view',
            actor_id: user.id,
          });
        } catch {
          // Ignore notification errors
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stories'] });
    },
  });
}

export function useLikeStory() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ storyId, isLiked }: { storyId: string; isLiked: boolean }) => {
      if (!user) return;

      if (isLiked) {
        const { error } = await supabase.from('story_likes').delete().eq('story_id', storyId).eq('user_id', user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('story_likes').upsert({
          story_id: storyId,
          user_id: user.id,
        }, { onConflict: 'story_id,user_id' });
        if (error && error.code !== '23505') throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stories'] });
    },
  });
}

export function useStoryViewers(storyId: string | null) {
  return useQuery({
    queryKey: ['story-viewers', storyId],
    queryFn: async () => {
      if (!storyId) return [];
      const { data: views } = await supabase
        .from('story_views')
        .select('viewer_id, viewed_at')
        .eq('story_id', storyId)
        .order('viewed_at', { ascending: false });

      if (!views || views.length === 0) return [];

      const viewerIds = views.map(v => v.viewer_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', viewerIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      return views.map(v => ({
        viewer_id: v.viewer_id,
        viewed_at: v.viewed_at,
        name: profileMap.get(v.viewer_id)?.name || 'Inconnu',
        avatar_url: profileMap.get(v.viewer_id)?.avatar_url || null,
      })) as StoryViewer[];
    },
    enabled: !!storyId,
  });
}

export function useDeleteStory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (storyId: string) => {
      const { error } = await supabase
        .from('stories')
        .delete()
        .eq('id', storyId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stories'] });
    },
  });
}
