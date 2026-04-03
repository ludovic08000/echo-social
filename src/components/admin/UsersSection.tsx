import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Ban, AlertTriangle, UserX, Pencil, X, Check, Eye, Users, ShieldAlert } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { motion, AnimatePresence } from 'framer-motion';

interface EditingUser {
  user_id: string;
  name: string;
  city: string;
  bio: string;
  profile_type: string;
}

function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/50" />
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="relative bg-background border border-border rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-2xl"
          onClick={e => e.stopPropagation()}
        >
          {children}
        </motion.div>
      </div>
    </AnimatePresence>
  );
}

export function UsersSection() {
  const [search, setSearch] = useState('');
  const [editingUser, setEditingUser] = useState<EditingUser | null>(null);
  const [viewUser, setViewUser] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
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
      const { error } = await supabase.from('profiles').update({ name: data.name, city: data.city, bio: data.bio, profile_type: data.profile_type }).eq('user_id', data.user_id);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: '✅ Profil mis à jour' }); setEditingUser(null); queryClient.invalidateQueries({ queryKey: ['admin-users'] }); },
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
      toast({ title: '🗑️ Utilisateur supprimé', description: data?.warning || 'Compte et données supprimés.' });
      setDeleteTarget(null);
      setDeleteConfirm('');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e: any) => toast({ title: 'Erreur', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold text-foreground">Utilisateurs</h2>
        </div>
        <Badge variant="secondary" className="shrink-0">{users?.length || 0}</Badge>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Rechercher par nom…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
      </div>

      {/* Card-based user list for better responsiveness */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Chargement…</div>
      ) : !users?.length ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Aucun utilisateur trouvé</div>
      ) : (
        <div className="space-y-2">
          {users.map((u, i) => (
            <motion.div key={u.user_id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.02 }}>
              <Card className="overflow-hidden">
                <CardContent className="p-3">
                  <div className="flex items-center gap-3">
                    {/* Avatar */}
                    <div className="w-10 h-10 rounded-full bg-accent flex items-center justify-center shrink-0 overflow-hidden">
                      {u.avatar_url ? (
                        <img src={u.avatar_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Users className="w-4 h-4 text-muted-foreground" />
                      )}
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground truncate">{u.name || 'Sans nom'}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] text-muted-foreground truncate">{u.city || 'Aucune ville'}</span>
                        <Badge variant="secondary" className="text-[10px] shrink-0">{u.profile_type || 'user'}</Badge>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {format(new Date(u.created_at), 'dd/MM/yy', { locale: fr })}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setViewUser(u)} title="Voir">
                        <Eye className="w-4 h-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingUser({
                        user_id: u.user_id, name: u.name || '', city: u.city || '', bio: u.bio || '', profile_type: u.profile_type || 'user',
                      })} title="Modifier">
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-500/10" onClick={() => banUser.mutate(u.user_id)} title="Bannir">
                        <Ban className="w-4 h-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:bg-destructive/10" onClick={() => setDeleteTarget({ id: u.user_id, name: u.name || 'Inconnu' })} title="Supprimer">
                        <UserX className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      {/* View Modal */}
      <Modal open={!!viewUser} onClose={() => setViewUser(null)}>
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-lg text-foreground">Détails</h3>
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setViewUser(null)}><X className="w-4 h-4" /></Button>
          </div>
          {viewUser && (
            <>
              <div className="flex items-center gap-3">
                <div className="w-14 h-14 rounded-full bg-accent overflow-hidden shrink-0">
                  {viewUser.avatar_url ? <img src={viewUser.avatar_url} className="w-full h-full object-cover" alt="" /> : <Users className="w-6 h-6 text-muted-foreground m-auto mt-4" />}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-foreground truncate">{viewUser.name || '-'}</p>
                  <p className="text-sm text-muted-foreground truncate">{viewUser.city || 'Aucune ville'}</p>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                <p><span className="text-muted-foreground">Bio :</span> {viewUser.bio || '-'}</p>
                <p><span className="text-muted-foreground">Type :</span> <Badge variant="secondary">{viewUser.profile_type || 'user'}</Badge></p>
                <p><span className="text-muted-foreground">Inscrit :</span> {format(new Date(viewUser.created_at), 'dd/MM/yyyy HH:mm', { locale: fr })}</p>
                <p className="text-xs text-muted-foreground font-mono break-all">ID : {viewUser.user_id}</p>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Edit Modal */}
      <Modal open={!!editingUser} onClose={() => setEditingUser(null)}>
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-lg text-foreground">Modifier le profil</h3>
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingUser(null)}><X className="w-4 h-4" /></Button>
          </div>
          {editingUser && (
            <>
              <div className="space-y-3">
                <div><label className="text-xs font-medium text-muted-foreground">Nom</label><Input value={editingUser.name} onChange={e => setEditingUser({ ...editingUser, name: e.target.value })} /></div>
                <div><label className="text-xs font-medium text-muted-foreground">Ville</label><Input value={editingUser.city} onChange={e => setEditingUser({ ...editingUser, city: e.target.value })} /></div>
                <div><label className="text-xs font-medium text-muted-foreground">Bio</label><Textarea value={editingUser.bio} onChange={e => setEditingUser({ ...editingUser, bio: e.target.value })} rows={3} /></div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Type</label>
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
              <div className="flex gap-2 justify-end pt-2">
                <Button variant="outline" size="sm" onClick={() => setEditingUser(null)}>Annuler</Button>
                <Button size="sm" onClick={() => updateUser.mutate(editingUser)} disabled={updateUser.isPending}>
                  <Check className="w-3.5 h-3.5 mr-1" />
                  <span className="truncate">{updateUser.isPending ? 'Enregistrement…' : 'Enregistrer'}</span>
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Delete Modal */}
      <Modal open={!!deleteTarget} onClose={() => { setDeleteTarget(null); setDeleteConfirm(''); }}>
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <h3 className="font-bold text-lg">Supprimer définitivement</h3>
          </div>
          {deleteTarget && (
            <>
              <p className="text-sm text-muted-foreground">
                Suppression de <strong className="text-foreground">{deleteTarget.name}</strong> et toutes ses données. <strong>Irréversible.</strong>
              </p>
              <div className="space-y-2">
                <p className="text-sm font-medium">Tapez <strong>SUPPRIMER</strong> :</p>
                <Input value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} placeholder="SUPPRIMER" />
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <Button variant="outline" size="sm" onClick={() => { setDeleteTarget(null); setDeleteConfirm(''); }}>Annuler</Button>
                <Button variant="destructive" size="sm" disabled={deleteConfirm !== 'SUPPRIMER' || deleteUser.isPending} onClick={() => deleteUser.mutate(deleteTarget.id)}>
                  <span className="truncate">{deleteUser.isPending ? 'Suppression…' : 'Supprimer'}</span>
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
