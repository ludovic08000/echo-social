import { useState, useRef } from 'react';
import { ArrowLeft, Plus, Trash2, Play, X } from 'lucide-react';
import { useAlbumMedia, useAddMediaToAlbum, useDeleteMedia, type Album, type AlbumMedia } from '@/hooks/useAlbums';
import { useImageUpload } from '@/hooks/useImageUpload';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

interface AlbumDetailProps {
  album: Album;
  isOwnProfile: boolean;
  onBack: () => void;
}

export function AlbumDetail({ album, isOwnProfile, onBack }: AlbumDetailProps) {
  const { user } = useAuth();
  const { data: media, isLoading } = useAlbumMedia(album.id);
  const addMedia = useAddMediaToAlbum();
  const deleteMedia = useDeleteMedia();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [viewMedia, setViewMedia] = useState<AlbumMedia | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !user) return;

    setIsUploading(true);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const isVideo = file.type.startsWith('video/');
        const isImage = file.type.startsWith('image/');

        if (!isVideo && !isImage) {
          toast.error(`${file.name} : format non supporté`);
          continue;
        }

        const maxSize = isVideo ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
        if (file.size > maxSize) {
          toast.error(`${file.name} : trop volumineux (max ${isVideo ? '50' : '5'} Mo)`);
          continue;
        }

        const bucket = isVideo ? 'videos' : 'post-images';
        const fileExt = file.name.split('.').pop();
        const filePath = `${user.id}/${Date.now()}-${i}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from(bucket)
          .upload(filePath, file);

        if (uploadError) {
          toast.error(`Erreur upload ${file.name}`);
          continue;
        }

        const { data: urlData } = supabase.storage
          .from(bucket)
          .getPublicUrl(filePath);

        await addMedia.mutateAsync({
          albumId: album.id,
          mediaUrl: urlData.publicUrl,
          mediaType: isVideo ? 'video' : 'image',
        });
      }
    } catch (error) {
      toast.error("Erreur lors de l'upload");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack} className="shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold truncate">{album.name}</h3>
          {album.description && (
            <p className="text-xs text-muted-foreground truncate">{album.description}</p>
          )}
        </div>
        {isOwnProfile && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <Plus className="w-4 h-4 mr-1" />
                  Ajouter
                </>
              )}
            </Button>
          </>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-3 gap-1">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="aspect-square bg-muted rounded animate-pulse" />
          ))}
        </div>
      ) : (!media || media.length === 0) ? (
        <div className="pulse-card p-8 text-center">
          <p className="text-muted-foreground text-sm">
            {isOwnProfile ? 'Ajoute des photos ou vidéos à cet album.' : 'Cet album est vide.'}
          </p>
          {isOwnProfile && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              <Plus className="w-4 h-4 mr-2" />
              Ajouter des médias
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1">
          {media.map((item) => (
            <button
              key={item.id}
              onClick={() => setViewMedia(item)}
              className="group relative aspect-square overflow-hidden rounded bg-muted"
            >
              {item.media_type === 'video' ? (
                <>
                  <video
                    src={item.media_url}
                    className="w-full h-full object-cover"
                    muted
                    preload="metadata"
                  />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-8 h-8 rounded-full bg-black/50 flex items-center justify-center">
                      <Play className="w-4 h-4 text-white fill-white" />
                    </div>
                  </div>
                </>
              ) : (
                <img
                  src={item.media_url}
                  alt=""
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
              )}
              {isOwnProfile && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteMedia.mutate({ mediaId: item.id, albumId: album.id });
                  }}
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-3 h-3 text-white" />
                </button>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Media viewer dialog */}
      <Dialog open={!!viewMedia} onOpenChange={() => setViewMedia(null)}>
        <DialogContent className="max-w-lg p-0 overflow-hidden bg-black border-none">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setViewMedia(null)}
            className="absolute top-2 right-2 z-10 text-white hover:bg-white/20"
          >
            <X className="w-5 h-5" />
          </Button>
          {viewMedia?.media_type === 'video' ? (
            <video
              src={viewMedia.media_url}
              controls
              autoPlay
              className="w-full max-h-[80vh] object-contain"
            />
          ) : (
            <img
              src={viewMedia?.media_url}
              alt=""
              className="w-full max-h-[80vh] object-contain"
            />
          )}
          {viewMedia?.caption && (
            <p className="p-3 text-white text-sm">{viewMedia.caption}</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
