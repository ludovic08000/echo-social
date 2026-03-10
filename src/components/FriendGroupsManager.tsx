import { useState } from 'react';
import { Plus, Users, Edit2, Trash2, Check, X, Star, Heart, Briefcase, Home } from 'lucide-react';
import {
  useFriendGroups,
  useCreateFriendGroup,
  useUpdateFriendGroup,
  useDeleteFriendGroup,
  useAddToFriendGroup,
  useRemoveFromFriendGroup,
  FriendGroup,
} from '@/hooks/useFriendGroups';
import { useFriendships } from '@/hooks/useFriendships';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/hooks/use-toast';

const ICONS = [
  { name: 'users', icon: Users },
  { name: 'star', icon: Star },
  { name: 'heart', icon: Heart },
  { name: 'briefcase', icon: Briefcase },
  { name: 'home', icon: Home },
];

const COLORS = [
  '#D4AF37', // Gold
  '#C4A35A', // Champagne
  '#8B7355', // Bronze
  '#708090', // Slate
  '#9370DB', // Purple
  '#20B2AA', // Teal
  '#CD5C5C', // Rose
];

export function FriendGroupsManager() {
  const { data: groups, isLoading } = useFriendGroups();
  const { data: friendships } = useFriendships();
  const createGroup = useCreateFriendGroup();
  const updateGroup = useUpdateFriendGroup();
  const deleteGroup = useDeleteFriendGroup();
  const addToGroup = useAddToFriendGroup();
  const removeFromGroup = useRemoveFromFriendGroup();

  const [newGroupName, setNewGroupName] = useState('');
  const [selectedColor, setSelectedColor] = useState(COLORS[0]);
  const [selectedIcon, setSelectedIcon] = useState('users');
  const [editingGroup, setEditingGroup] = useState<FriendGroup | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [managingGroup, setManagingGroup] = useState<FriendGroup | null>(null);

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;

    try {
      await createGroup.mutateAsync({
        name: newGroupName.trim(),
        color: selectedColor,
        icon: selectedIcon,
      });
      setNewGroupName('');
      setIsCreateOpen(false);
      toast({ title: 'Groupe créé !', description: `"${newGroupName}" a été ajouté` });
    } catch (error) {
      toast({ title: 'Erreur', description: 'Impossible de créer le groupe', variant: 'destructive' });
    }
  };

  const handleDeleteGroup = async (group: FriendGroup) => {
    try {
      await deleteGroup.mutateAsync(group.id);
    } catch (error) {
      toast({ title: 'Erreur', description: 'Impossible de supprimer le groupe', variant: 'destructive' });
    }
  };

  const handleToggleMember = async (groupId: string, friendUserId: string, isInGroup: boolean) => {
    try {
      if (isInGroup) {
        await removeFromGroup.mutateAsync({ groupId, friendUserId });
      } else {
        await addToGroup.mutateAsync({ groupId, friendUserId });
      }
    } catch (error) {
      toast({ title: 'Erreur', description: 'Impossible de modifier le groupe', variant: 'destructive' });
    }
  };

  const getIconComponent = (iconName: string) => {
    const found = ICONS.find(i => i.name === iconName);
    return found ? found.icon : Users;
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="premium-card p-4 animate-pulse">
            <div className="h-6 w-32 bg-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  const friends = friendships?.friends || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-semibold">Groupes d'amis</h3>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="premium-button h-9">
              <Plus className="w-4 h-4 mr-2" />
              Nouveau
            </Button>
          </DialogTrigger>
          <DialogContent className="premium-card border-0">
            <DialogHeader>
              <DialogTitle className="font-display">Créer un groupe</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <Input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Nom du groupe..."
                className="premium-input"
              />

              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Couleur</label>
                <div className="flex gap-2">
                  {COLORS.map((color) => (
                    <button
                      key={color}
                      onClick={() => setSelectedColor(color)}
                      className={`w-8 h-8 rounded-full transition-all duration-200 ${
                        selectedColor === color ? 'ring-2 ring-offset-2 ring-primary scale-110' : 'hover:scale-105'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Icône</label>
                <div className="flex gap-2">
                  {ICONS.map(({ name, icon: Icon }) => (
                    <button
                      key={name}
                      onClick={() => setSelectedIcon(name)}
                      className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200 ${
                        selectedIcon === name
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary hover:bg-secondary/80'
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                    </button>
                  ))}
                </div>
              </div>

              <Button
                onClick={handleCreateGroup}
                disabled={!newGroupName.trim() || createGroup.isPending}
                className="w-full premium-button"
              >
                {createGroup.isPending ? 'Création...' : 'Créer le groupe'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {groups?.length === 0 ? (
        <div className="premium-card p-8 text-center">
          <Users className="w-12 h-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">Aucun groupe créé</p>
          <p className="text-sm text-muted-foreground/70 mt-1">
            Organisez vos amis par catégories
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups?.map((group) => {
            const IconComponent = getIconComponent(group.icon);
            return (
              <div
                key={group.id}
                className="premium-card p-4 group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center"
                      style={{ backgroundColor: group.color + '20', color: group.color }}
                    >
                      <IconComponent className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="font-medium">{group.name}</h4>
                      <p className="text-sm text-muted-foreground">
                        {group.members?.length || 0} membre{(group.members?.length || 0) > 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setManagingGroup(group)}
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="premium-card border-0 max-h-[80vh] overflow-y-auto">
                        <DialogHeader>
                          <DialogTitle className="font-display">Gérer "{group.name}"</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4 pt-4">
                          <p className="text-sm text-muted-foreground">
                            Sélectionnez les amis à inclure dans ce groupe
                          </p>
                          {friends.length === 0 ? (
                            <p className="text-center text-muted-foreground py-4">
                              Aucun ami à ajouter
                            </p>
                          ) : (
                            <div className="space-y-2">
                              {friends.map((friendship) => {
                                const isInGroup = group.members?.some(
                                  (m) => m.friend_user_id === friendship.profile.user_id
                                );
                                return (
                                  <button
                                    key={friendship.id}
                                    onClick={() =>
                                      handleToggleMember(
                                        group.id,
                                        friendship.profile.user_id,
                                        isInGroup || false
                                      )
                                    }
                                    className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-200 ${
                                      isInGroup
                                        ? 'bg-primary/10 border border-primary/30'
                                        : 'bg-secondary/50 hover:bg-secondary'
                                    }`}
                                  >
                                    <UserAvatar
                                      src={friendship.profile.avatar_url}
                                      alt={friendship.profile.name}
                                      size="sm"
                                    />
                                    <span className="flex-1 text-left font-medium">
                                      {friendship.profile.name}
                                    </span>
                                    {isInGroup && (
                                      <Check className="w-5 h-5 text-primary" />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </DialogContent>
                    </Dialog>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleDeleteGroup(group)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Member avatars preview */}
                {group.members && group.members.length > 0 && (
                  <div className="flex items-center gap-1 mt-3 pt-3 border-t border-border/50">
                    <div className="flex -space-x-2">
                      {group.members.slice(0, 5).map((member) => (
                        <UserAvatar
                          key={member.id}
                          src={member.profile?.avatar_url}
                          alt={member.profile?.name}
                          size="xs"
                          className="ring-2 ring-card"
                        />
                      ))}
                    </div>
                    {group.members.length > 5 && (
                      <span className="text-xs text-muted-foreground ml-2">
                        +{group.members.length - 5}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
