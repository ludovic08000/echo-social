import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

export interface Album {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  cover_url: string | null;
  privacy: string;
  created_at: string;
  updated_at: string;
}

export interface AlbumMedia {
  id: string;
  album_id: string;
  user_id: string;
  media_url: string;
  media_type: string;
  caption: string | null;
  created_at: string;
}

export function useAlbums(userId?: string) {
  return useQuery({
    queryKey: ['albums', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('albums')
        .select('*')
        .eq('user_id', userId!)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as Album[];
    },
    enabled: !!userId,
  });
}

export function useAlbumMedia(albumId?: string) {
  return useQuery({
    queryKey: ['album-media', albumId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('album_media')
        .select('*')
        .eq('album_id', albumId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as AlbumMedia[];
    },
    enabled: !!albumId,
  });
}

export function useCreateAlbum() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ name, description }: { name: string; description?: string }) => {
      if (!user) throw new Error('Non connecté');
      const { data, error } = await supabase
        .from('albums')
        .insert({ user_id: user.id, name, description: description || null })
        .select()
        .single();
      if (error) throw error;
      return data as Album;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['albums'] });
      toast.success('Album créé !');
    },
    onError: () => {
      toast.error("Erreur lors de la création de l'album");
    },
  });
}

export function useDeleteAlbum() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (albumId: string) => {
      const { error } = await supabase.from('albums').delete().eq('id', albumId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['albums'] });
    },
    onError: () => {
      toast.error("Erreur lors de la suppression");
    },
  });
}

export function useAddMediaToAlbum() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      albumId,
      mediaUrl,
      mediaType,
      caption,
    }: {
      albumId: string;
      mediaUrl: string;
      mediaType: 'image' | 'video';
      caption?: string;
    }) => {
      if (!user) throw new Error('Non connecté');
      const { data, error } = await supabase
        .from('album_media')
        .insert({
          album_id: albumId,
          user_id: user.id,
          media_url: mediaUrl,
          media_type: mediaType,
          caption: caption || null,
        })
        .select()
        .single();
      if (error) throw error;

      // Update album cover if it's the first media or an image
      if (mediaType === 'image') {
        await supabase
          .from('albums')
          .update({ cover_url: mediaUrl })
          .eq('id', albumId)
          .is('cover_url', null);
      }

      return data as AlbumMedia;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['album-media', variables.albumId] });
      queryClient.invalidateQueries({ queryKey: ['albums'] });
      toast.success('Média ajouté !');
    },
    onError: () => {
      toast.error("Erreur lors de l'ajout du média");
    },
  });
}

export function useDeleteMedia() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ mediaId, albumId }: { mediaId: string; albumId: string }) => {
      const { error } = await supabase.from('album_media').delete().eq('id', mediaId);
      if (error) throw error;
      return albumId;
    },
    onSuccess: (albumId) => {
      queryClient.invalidateQueries({ queryKey: ['album-media', albumId] });
      queryClient.invalidateQueries({ queryKey: ['albums'] });
    },
    onError: () => {
      toast.error('Erreur lors de la suppression');
    },
  });
}

export function useAlbumMediaCount(albumId?: string) {
  return useQuery({
    queryKey: ['album-media-count', albumId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('album_media')
        .select('*', { count: 'exact', head: true })
        .eq('album_id', albumId!);
      if (error) throw error;
      return count || 0;
    },
    enabled: !!albumId,
  });
}
