import { Link } from 'react-router-dom';
import { Users, Lock, Globe, Settings, Plus, ChevronRight } from 'lucide-react';
import { useMyGroups } from '@/hooks/useGroups';
import { CreateGroupDialog } from './CreateGroupDialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function MyGroupsList() {
  const { data: groups, isLoading } = useMyGroups();

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 p-4 rounded-xl bg-secondary/50">
            <Skeleton className="w-12 h-12 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Create button */}
      <CreateGroupDialog>
        <Button className="w-full premium-button">
          <Plus className="w-4 h-4 mr-2" />
          Créer un groupe
        </Button>
      </CreateGroupDialog>

      {/* Groups list */}
      {!groups || groups.length === 0 ? (
        <div className="text-center py-8">
          <Users className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">
            Vous n'avez pas encore créé ou rejoint de groupe
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => (
            <div
              key={group.id}
              className="flex items-center gap-3 p-4 rounded-xl bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer group"
            >
              {/* Group avatar */}
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                {group.cover_image_url ? (
                  <img
                    src={group.cover_image_url}
                    alt={group.name}
                    className="w-full h-full object-cover rounded-xl"
                  />
                ) : (
                  <Users className="w-6 h-6 text-primary" />
                )}
              </div>

              {/* Group info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="font-medium truncate">{group.name}</h4>
                  {group.privacy === 'private' ? (
                    <Lock className="w-3.5 h-3.5 text-muted-foreground" />
                  ) : (
                    <Globe className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {group.member_count || 0} membres
                  {group.is_admin && ' • Admin'}
                </p>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {group.is_admin && (
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Settings className="w-4 h-4" />
                  </Button>
                )}
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
