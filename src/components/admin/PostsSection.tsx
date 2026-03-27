import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Trash2, Pencil, X, Check, Eye } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

export function PostsSection() {
  const [search, setSearch] = useState('');
  const [editingPost, setEditingPost] = useState<{ id: string; body: string } | null>(null);
  const [viewPost, setViewPost] = useState<any>(null);
  const queryClient = useQueryClient();

  const { data: posts, isLoading } = useQuery({
    queryKey: ['admin-posts', search],
    queryFn: async () => {
      let profileQuery = supabase.from('profiles').select('user_id, name');
      if (search.trim()) {
        profileQuery = profileQuery.ilike('name', `%${search}%`);
      }
      const { data: profiles } = await profileQuery;

      let postQuery = supabase.from('posts').select('id, body, image_url, created_at, user_id').order('created_at', { ascending: false }).limit(50);
      if (search.trim() && profiles?.length) {
        postQuery = postQuery.in('user_id', profiles.map(p => p.user_id));
      }
      const { data, error } = await postQuery;
      if (error) throw error;

      const allProfiles = profiles || [];
      if (!search.trim()) {
        const userIds = [...new Set(data?.map(p => p.user_id) || [])];
        const { data: p2 } = await supabase.from('profiles').select('user_id, name').in('user_id', userIds);
        if (p2) allProfiles.push(...p2.filter(p => !allProfiles.find(ap => ap.user_id === p.user_id)));
      }

      return data?.map(p => ({ ...p, author: allProfiles.find(pr => pr.user_id === p.user_id)?.name || 'Inconnu' })) || [];
    },
  });

  const deletePost = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('posts').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: '🗑️ Publication supprimée' });
      queryClient.invalidateQueries({ queryKey: ['admin-posts'] });
    },
  });

  const updatePost = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => {
      const { error } = await supabase.from('posts').update({ body }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: '✅ Publication modifiée' });
      setEditingPost(null);
      queryClient.invalidateQueries({ queryKey: ['admin-posts'] });
    },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-foreground">Publications</h2>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Rechercher par auteur..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
      </div>
      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Auteur</TableHead>
              <TableHead>Contenu</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !posts?.length ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Aucune publication</TableCell></TableRow>
            ) : posts.map(p => (
              <TableRow key={p.id}>
                <TableCell className="font-medium text-sm">{p.author}</TableCell>
                <TableCell className="text-xs max-w-[250px] truncate">{p.body}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{format(new Date(p.created_at), 'dd/MM HH:mm', { locale: fr })}</TableCell>
                <TableCell>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setViewPost(p)}>
                      <Eye className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditingPost({ id: p.id, body: p.body || '' })}>
                      <Pencil className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => deletePost.mutate(p.id)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* View post modal */}
      {viewPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setViewPost(null)}>
          <div className="bg-background border border-border rounded-xl p-6 w-full max-w-lg mx-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg">Détail publication</h3>
              <Button size="sm" variant="ghost" onClick={() => setViewPost(null)}><X className="w-4 h-4" /></Button>
            </div>
            <p className="text-sm"><strong>Auteur :</strong> {viewPost.author}</p>
            <p className="text-sm"><strong>Date :</strong> {format(new Date(viewPost.created_at), 'dd/MM/yyyy HH:mm', { locale: fr })}</p>
            <p className="text-sm whitespace-pre-wrap bg-muted/50 rounded-lg p-3">{viewPost.body}</p>
            {viewPost.image_url && <img src={viewPost.image_url} className="rounded-lg max-h-64 object-cover" alt="" />}
            <p className="text-xs text-muted-foreground">ID : {viewPost.id}</p>
          </div>
        </div>
      )}

      {/* Edit post modal */}
      {editingPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingPost(null)}>
          <div className="bg-background border border-border rounded-xl p-6 w-full max-w-lg mx-4 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg">Modifier la publication</h3>
              <Button size="sm" variant="ghost" onClick={() => setEditingPost(null)}><X className="w-4 h-4" /></Button>
            </div>
            <Textarea
              value={editingPost.body}
              onChange={e => setEditingPost({ ...editingPost, body: e.target.value })}
              rows={6}
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setEditingPost(null)}>Annuler</Button>
              <Button size="sm" onClick={() => updatePost.mutate(editingPost)} disabled={updatePost.isPending}>
                <Check className="w-3 h-3 mr-1" /> {updatePost.isPending ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
