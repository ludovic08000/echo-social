import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface Page {
  id: string;
  name: string;
  description: string | null;
  category: string;
  cover_image_url: string | null;
  profile_image_url: string | null;
  website_url: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  follower_count?: number;
  is_following?: boolean;
  is_admin?: boolean;
}

export function usePages() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['pages'],
    queryFn: async (): Promise<Page[]> => {
      const { data: pages, error } = await supabase
        .from('pages')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      const pagesWithStats = await Promise.all(
        (pages || []).map(async (page) => {
          const [{ count: followerCount }, { data: following }, { data: adminship }] = await Promise.all([
            supabase
              .from('page_followers')
              .select('*', { count: 'exact', head: true })
              .eq('page_id', page.id),
            user
              ? supabase
                  .from('page_followers')
                  .select('id')
                  .eq('page_id', page.id)
                  .eq('user_id', user.id)
                  .maybeSingle()
              : Promise.resolve({ data: null }),
            user
              ? supabase
                  .from('page_admins')
                  .select('role')
                  .eq('page_id', page.id)
                  .eq('user_id', user.id)
                  .maybeSingle()
              : Promise.resolve({ data: null }),
          ]);

          return {
            ...page,
            follower_count: followerCount || 0,
            is_following: !!following,
            is_admin: !!adminship,
          };
        })
      );

      return pagesWithStats;
    },
  });
}

export function useMyPages() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['my-pages', user?.id],
    queryFn: async (): Promise<Page[]> => {
      if (!user) return [];

      const { data: adminships, error } = await supabase
        .from('page_admins')
        .select('page_id, role')
        .eq('user_id', user.id);

      if (error) throw error;
      if (!adminships || adminships.length === 0) return [];

      const pageIds = adminships.map((a) => a.page_id);

      const { data: pages } = await supabase
        .from('pages')
        .select('*')
        .in('id', pageIds)
        .order('created_at', { ascending: false });

      return (pages || []).map((page) => ({
        ...page,
        is_admin: true,
      }));
    },
    enabled: !!user,
  });
}

export function usePage(pageId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['page', pageId],
    queryFn: async (): Promise<Page | null> => {
      const { data: page, error } = await supabase
        .from('pages')
        .select('*')
        .eq('id', pageId)
        .single();

      if (error) throw error;

      const [{ count: followerCount }, { data: following }, { data: adminship }] = await Promise.all([
        supabase
          .from('page_followers')
          .select('*', { count: 'exact', head: true })
          .eq('page_id', pageId),
        user
          ? supabase
              .from('page_followers')
              .select('id')
              .eq('page_id', pageId)
              .eq('user_id', user.id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        user
          ? supabase
              .from('page_admins')
              .select('role')
              .eq('page_id', pageId)
              .eq('user_id', user.id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      return {
        ...page,
        follower_count: followerCount || 0,
        is_following: !!following,
        is_admin: !!adminship,
      };
    },
    enabled: !!pageId,
  });
}

export function useCreatePage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      name,
      description,
      category,
      cover_image_url,
      profile_image_url,
      website_url,
      phone,
      email,
      address,
    }: {
      name: string;
      description?: string;
      category: string;
      cover_image_url?: string;
      profile_image_url?: string;
      website_url?: string;
      phone?: string;
      email?: string;
      address?: string;
    }) => {
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('pages')
        .insert({
          name,
          description: description || null,
          category,
          cover_image_url: cover_image_url || null,
          profile_image_url: profile_image_url || null,
          website_url: website_url || null,
          phone: phone || null,
          email: email || null,
          address: address || null,
          created_by: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['my-pages'] });
    },
  });
}

export function useFollowPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (pageId: string) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('page_followers')
        .insert({
          page_id: pageId,
          user_id: user.id,
        });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['page'] });
    },
  });
}

export function useUnfollowPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (pageId: string) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('page_followers')
        .delete()
        .eq('page_id', pageId)
        .eq('user_id', user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['page'] });
    },
  });
}
