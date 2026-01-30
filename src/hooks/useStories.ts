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
  is_viewed: boolean;
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
  const { user } = useAuth();

  return useQuery({
    queryKey: ['stories'],
    queryFn: async () => {
      const now = new Date().toISOString();
      
      const { data: stories, error } = await supabase
        .from('stories')
        .select('*')
        .gt('expires_at', now)
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Get profile info
      const userIds = [...new Set(stories.map(s => s.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', userIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      // Get view counts and user views
      const storyIds = stories.map(s => s.id);
      const [viewsRes, userViewsRes] = await Promise.all([
        supabase.from('story_views').select('story_id').in('story_id', storyIds),
        user
          ? supabase.from('story_views').select('story_id').eq('viewer_id', user.id).in('story_id', storyIds)
          : Promise.resolve({ data: [] }),
      ]);

      const viewsCount: Record<string, number> = {};
      const userViews = new Set(userViewsRes.data?.map(v => v.story_id) || []);

      viewsRes.data?.forEach(v => {
        viewsCount[v.story_id] = (viewsCount[v.story_id] || 0) + 1;
      });

      const enrichedStories: Story[] = stories.map(story => {
        const profile = profileMap.get(story.user_id);
        return {
          ...story,
          profile: {
            name: profile?.name || 'Unknown',
            avatar_url: profile?.avatar_url || null,
          },
          views_count: viewsCount[story.id] || 0,
          is_viewed: userViews.has(story.id),
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
  });
}

export function useCreateStory() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ imageUrl, caption }: { imageUrl: string; caption?: string }) => {
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('stories')
        .insert({
          user_id: user.id,
          image_url: imageUrl,
          caption: caption || null,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
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

      if (error && !error.message.includes('duplicate')) throw error;

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
