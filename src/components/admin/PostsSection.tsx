import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Search, Trash2, Pencil, X, Check, Eye, FileText } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { motion, AnimatePresence } from 'framer-motion';

export function PostsSection() {
  const [search, setSearch] = useState('');
  const [editingPost, setEditingPost] = useState<{ id: string; body: string } | null>(null);
  const [viewPost, setViewPost] = useState<any>(null);
  const queryClient = useQueryClient();

  const { data: posts, isLoading } = useQuery({
    queryKey: ['admin-posts', search],
    queryFn: async () => {
      let profileQuery = supabase.from('profiles').select('user_id, name');
      if (search.trim()) profileQuery = profileQuery.ilike('name', `%${search}%`);
      const { data: profiles } = await profileQuery;

      let postQuery = supabase.from('posts').select('id, body, image_url, created_at, user_id').order('created_at', { ascending: false }).limit(50);
      if (search.trim() && profiles?.length) postQuery = postQuery.in('user_id', profiles.map(p => p.user_id));
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
    mutationFn: async (id: string) => { const { error } = await supabase.from('posts').delete().eq('id', id); if (error) throw error; },
    onSuccess: () => { toast({ title: '🗑️ Publication supprimée' }); queryClient.invalidateQueries({ queryKey: ['admin-posts'] }); },
  });

  const updatePost = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => { const { error } = await supabase.from('posts').update({ body }).eq('id', id); if (error) throw error; },
    onSuccess: () => { toast({ title: '✅ Publication modifiée' }); setEditingPost(null); queryClient.invalidateQueries({ queryKey: ['admin-posts'] }); },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <FileText className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-bold text-foreground">Publications</h2>
        <Badge variant="secondary" className="ml-auto shrink-0">{posts?.length || 0}</Badge>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Rechercher par auteur…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Chargement…</div>
      ) : !posts?.length ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Aucune publication</div>
      ) : (
        <div className="space-y-2">
          {posts.map((p, i) => (
            <motion.div key={p.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.02 }}>
              <Card>
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-foreground truncate">{p.author}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">{format(new Date(p.created_at), 'dd/MM HH:mm', { locale: fr })}</span>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">{p.body}</p>
                      {p.image_url && <div className="mt-1.5 w-12 h-12 rounded-lg bg-accent overflow-hidden"><img src={p.image_url} className="w-full h-full object-cover" alt="" /></div>}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setViewPost(p)} title="Voir"><Eye className="w-4 h-4" /></Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingPost({ id: p.id, body: p.body || '' })} title="Modifier"><Pencil className="w-4 h-4" /></Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:bg-destructive/10" onClick={() => deletePost.mutate(p.id)} title="Supprimer"><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      {/* View Modal */}
      {viewPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setViewPost(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative bg-background border border-border rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-2xl p-6 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg text-foreground">Publication</h3>
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setViewPost(null)}><X className="w-4 h-4" /></Button>
            </div>
            <p className="text-sm"><span className="text-muted-foreground">Auteur :</span> {viewPost.author}</p>
            <p className="text-sm"><span className="text-muted-foreground">Date :</span> {format(new Date(viewPost.created_at), 'dd/MM/yyyy HH:mm', { locale: fr })}</p>
            <p className="text-sm whitespace-pre-wrap bg-accent rounded-lg p-3">{viewPost.body}</p>
            {viewPost.image_url && <img src={viewPost.image_url} className="rounded-lg max-h-64 object-cover" alt="" />}
            <p className="text-xs text-muted-foreground font-mono break-all">ID : {viewPost.id}</p>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setEditingPost(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative bg-background border border-border rounded-2xl w-full max-w-lg shadow-2xl p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg text-foreground">Modifier</h3>
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingPost(null)}><X className="w-4 h-4" /></Button>
            </div>
            <Textarea value={editingPost.body} onChange={e => setEditingPost({ ...editingPost, body: e.target.value })} rows={6} />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setEditingPost(null)}>Annuler</Button>
              <Button size="sm" onClick={() => updatePost.mutate(editingPost)} disabled={updatePost.isPending}>
                <Check className="w-3.5 h-3.5 mr-1" />
                <span className="truncate">{updatePost.isPending ? 'Enregistrement…' : 'Enregistrer'}</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
