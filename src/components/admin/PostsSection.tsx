import { useQuery, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

export function PostsSection() {
  const { data: posts, isLoading } = useQuery({
    queryKey: ['admin-posts'],
    queryFn: async () => {
      const { data, error } = await supabase.from('posts').select('id, body, image_url, created_at, user_id').order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      const userIds = [...new Set(data?.map(p => p.user_id) || [])];
      const { data: profiles } = await supabase.from('profiles').select('user_id, name').in('user_id', userIds);
      return data?.map(p => ({ ...p, author: profiles?.find(pr => pr.user_id === p.user_id)?.name || 'Inconnu' })) || [];
    },
  });

  const deletePost = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('posts').delete().eq('id', id);
      if (error) throw error;
    },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-foreground">Publications récentes</h2>
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
                  <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => deletePost.mutate(p.id)}>Supprimer</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
