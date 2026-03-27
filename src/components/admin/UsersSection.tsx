import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Ban, AlertTriangle, UserX, Pencil, X, Check, Eye } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

interface EditingUser {
  user_id: string;
  name: string;
  city: string;
  bio: string;
  profile_type: string;
}

export function UsersSection() {
  const [search, setSearch] = useState('');
  const [editingUser, setEditingUser] = useState<EditingUser | null>(null);
  const [viewUser, setViewUser] = useState<any>(null);
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users', search],
    queryFn: async () => {
      let query = supabase.from('profiles').select('user_id, name, avatar_url, city, bio, created_at, profile_type').order('created_at', { ascending: false }).limit(50);
      if (search.trim()) query = query.ilike('name', `%${search}%`);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const banUser = useMutation({
    mutationFn: async (userId: string) => {
      if (!user) throw new Error('Non authentifié');
      const { error } = await supabase.from('banned_users').insert({ user_id: userId, reason: 'Banni par admin', banned_by: user.id });
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: '🚫 Utilisateur banni' }); queryClient.invalidateQueries({ queryKey: ['admin-users'] }); },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const updateUser = useMutation({
    mutationFn: async (data: EditingUser) => {
      const { error } = await supabase
        .from('profiles')
        .update({ name: data.name, city: data.city, bio: data.bio, profile_type: data.profile_type })
        .eq('user_id', data.user_id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: '✅ Profil mis à jour' });
      setEditingUser(null);
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const deleteUser = useMutation({
    mutationFn: async (userId: string) => {
      const { data, error } = await supabase.functions.invoke('admin-delete-user', { body: { target_user_id: userId } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({ title: '🗑️ Utilisateur supprimé', description: data?.warning || 'Compte et données supprimés définitivement.' });
      setDeleteTarget(null);
      setDeleteConfirm('');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  const startEdit = (u: any) => {
    setEditingUser({
      user_id: u.user_id,
      name: u.name || '',
      city: u.city || '',
      bio: u.bio || '',
      profile_type: u.profile_type || 'user',
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Utilisateurs</h2>
        <Badge variant="secondary">{users?.length || 0} résultats</Badge>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Rechercher par nom..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
      </div>
      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>Ville</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Inscrit le</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : !users?.length ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Aucun utilisateur</TableCell></TableRow>
            ) : users.map(u => (
              <TableRow key={u.user_id}>
                <TableCell className="font-medium text-sm">{u.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{u.city || '-'}</TableCell>
                <TableCell><Badge variant="secondary" className="text-[10px]">{u.profile_type || 'user'}</Badge></TableCell>
                <TableCell className="text-xs text-muted-foreground">{format(new Date(u.created_at), 'dd/MM/yyyy', { locale: fr })}</TableCell>
                <TableCell>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setViewUser(u)}>
                      <Eye className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startEdit(u)}>
                      <Pencil className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => banUser.mutate(u.user_id)}>
                      <Ban className="w-3 h-3 mr-1" /> Bannir
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground" onClick={() => setDeleteTarget({ id: u.user_id, name: u.name || 'Inconnu' })}>
                      <UserX className="w-3 h-3" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* View user detail modal */}
      {viewUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setViewUser(null)}>
          <div className="bg-background border border-border rounded-xl p-6 w-full max-w-md mx-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg">Détails utilisateur</h3>
              <Button size="sm" variant="ghost" onClick={() => setViewUser(null)}><X className="w-4 h-4" /></Button>
            </div>
            {viewUser.avatar_url && <img src={viewUser.avatar_url} className="w-16 h-16 rounded-full object-cover" alt="" />}
            <div className="space-y-2 text-sm">
              <p><strong>Nom :</strong> {viewUser.name || '-'}</p>
              <p><strong>Ville :</strong> {viewUser.city || '-'}</p>
              <p><strong>Bio :</strong> {viewUser.bio || '-'}</p>
              <p><strong>Type :</strong> {viewUser.profile_type || 'user'}</p>
              <p><strong>Inscrit :</strong> {format(new Date(viewUser.created_at), 'dd/MM/yyyy HH:mm', { locale: fr })}</p>
              <p className="text-xs text-muted-foreground">ID : {viewUser.user_id}</p>
            </div>
          </div>
        </div>
      )}

      {/* Edit user modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingUser(null)}>
          <div className="bg-background border border-border rounded-xl p-6 w-full max-w-md mx-4 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg">Modifier le profil</h3>
              <Button size="sm" variant="ghost" onClick={() => setEditingUser(null)}><X className="w-4 h-4" /></Button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium">Nom</label>
                <Input value={editingUser.name} onChange={e => setEditingUser({ ...editingUser, name: e.target.value })} />
              </div>
              <div>
                <label className="text-sm font-medium">Ville</label>
                <Input value={editingUser.city} onChange={e => setEditingUser({ ...editingUser, city: e.target.value })} />
              </div>
              <div>
                <label className="text-sm font-medium">Bio</label>
                <Textarea value={editingUser.bio} onChange={e => setEditingUser({ ...editingUser, bio: e.target.value })} rows={3} />
              </div>
              <div>
                <label className="text-sm font-medium">Type de profil</label>
                <Select value={editingUser.profile_type} onValueChange={v => setEditingUser({ ...editingUser, profile_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Utilisateur</SelectItem>
                    <SelectItem value="creator">Créateur</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setEditingUser(null)}>Annuler</Button>
              <Button size="sm" onClick={() => updateUser.mutate(editingUser)} disabled={updateUser.isPending}>
                <Check className="w-3 h-3 mr-1" /> {updateUser.isPending ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setDeleteTarget(null); setDeleteConfirm(''); }}>
          <div className="bg-background border border-border rounded-xl p-6 w-full max-w-md mx-4 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              <h3 className="font-bold text-lg">Supprimer définitivement</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Vous êtes sur le point de supprimer <strong className="text-foreground">{deleteTarget.name}</strong> et toutes ses données. Cette action est <strong>irréversible</strong>.
            </p>
            <div className="space-y-2">
              <p className="text-sm font-medium">Tapez <strong>SUPPRIMER</strong> pour confirmer :</p>
              <Input value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} placeholder="SUPPRIMER" />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => { setDeleteTarget(null); setDeleteConfirm(''); }}>Annuler</Button>
              <Button variant="destructive" size="sm" disabled={deleteConfirm !== 'SUPPRIMER' || deleteUser.isPending} onClick={() => deleteUser.mutate(deleteTarget.id)}>
                {deleteUser.isPending ? 'Suppression…' : 'Supprimer définitivement'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
