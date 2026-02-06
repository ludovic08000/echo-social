import { useState } from 'react';
import { Plus, FolderOpen, Trash2, Image, Video } from 'lucide-react';
import { useAlbums, useCreateAlbum, useDeleteAlbum, type Album } from '@/hooks/useAlbums';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface AlbumsListProps {
  userId: string;
  isOwnProfile: boolean;
  onSelectAlbum: (album: Album) => void;
}

export function AlbumsList({ userId, isOwnProfile, onSelectAlbum }: AlbumsListProps) {
  const { data: albums, isLoading } = useAlbums(userId);
  const createAlbum = useCreateAlbum();
  const deleteAlbum = useDeleteAlbum();
  const [newAlbumName, setNewAlbumName] = useState('');
  const [newAlbumDesc, setNewAlbumDesc] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleCreate = async () => {
    if (!newAlbumName.trim()) return;
    await createAlbum.mutateAsync({ name: newAlbumName.trim(), description: newAlbumDesc.trim() || undefined });
    setNewAlbumName('');
    setNewAlbumDesc('');
    setIsDialogOpen(false);
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="aspect-square bg-muted rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {isOwnProfile && (
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="w-full">
              <Plus className="w-4 h-4 mr-2" />
              Créer un album
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Nouvel album</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <Input
                placeholder="Nom de l'album"
                value={newAlbumName}
                onChange={(e) => setNewAlbumName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <Input
                placeholder="Description (optionnel)"
                value={newAlbumDesc}
                onChange={(e) => setNewAlbumDesc(e.target.value)}
              />
              <Button
                onClick={handleCreate}
                disabled={!newAlbumName.trim() || createAlbum.isPending}
                className="w-full"
              >
                {createAlbum.isPending ? 'Création...' : 'Créer'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {(!albums || albums.length === 0) ? (
        <div className="pulse-card p-8 text-center">
          <FolderOpen className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground text-sm">
            {isOwnProfile ? 'Crée ton premier album pour organiser tes photos et vidéos.' : 'Aucun album.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {albums.map((album) => (
            <button
              key={album.id}
              onClick={() => onSelectAlbum(album)}
              className="group relative aspect-square rounded-xl overflow-hidden bg-muted border border-border hover:border-primary/50 transition-all text-left"
            >
              {album.cover_url ? (
                <img
                  src={album.cover_url}
                  alt={album.name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-secondary/50">
                  <FolderOpen className="w-10 h-10 text-muted-foreground" />
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                <p className="text-white text-sm font-semibold truncate">{album.name}</p>
                {album.description && (
                  <p className="text-white/70 text-xs truncate">{album.description}</p>
                )}
              </div>
              {isOwnProfile && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Supprimer cet album et tout son contenu ?')) {
                      deleteAlbum.mutate(album.id);
                    }
                  }}
                  className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-3.5 h-3.5 text-white" />
                </button>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
