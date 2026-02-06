import { Link } from 'react-router-dom';
import { MapPin, Cake, GraduationCap, Briefcase, Mail, Users, Globe, Lock, Check, ChevronRight, Heart, Sparkles } from 'lucide-react';
import { Profile, FieldVisibility } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { FriendshipButton } from '@/components/FriendshipButton';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/lib/auth';
import { useUpdateProfile } from '@/hooks/useProfile';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useCallback } from 'react';

type VisibilityLevel = 'public' | 'friends' | 'only_me';

const visibilityConfig: Record<VisibilityLevel, { label: string; icon: React.ReactNode; color: string }> = {
  public: { label: 'Public', icon: <Globe className="w-3.5 h-3.5" />, color: 'text-emerald-400' },
  friends: { label: 'Amis', icon: <Users className="w-3.5 h-3.5" />, color: 'text-blue-400' },
  only_me: { label: 'Moi seul', icon: <Lock className="w-3.5 h-3.5" />, color: 'text-amber-400' },
};

interface ProfileFriend {
  user_id: string;
  name: string;
  avatar_url: string | null;
}

interface ProfileOverviewProps {
  profile: Profile;
  isOwnProfile: boolean;
  isFriend: boolean;
  friendsCount: number;
  onNavigateToAbout: () => void;
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return dateStr; }
}

function VisibilityDropdown({
  visKey,
  currentLevel,
  visibility,
  onChangeVisibility,
}: {
  visKey: keyof FieldVisibility;
  currentLevel: VisibilityLevel;
  visibility: FieldVisibility;
  onChangeVisibility: (visKey: keyof FieldVisibility, level: VisibilityLevel) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "h-7 w-7 rounded-full flex items-center justify-center transition-colors hover:bg-background/80",
            visibilityConfig[currentLevel].color
          )}
          title={`Visible par : ${visibilityConfig[currentLevel].label}`}
        >
          {visibilityConfig[currentLevel].icon}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px] rounded-xl border-border/50 bg-card/95 backdrop-blur-lg">
        <p className="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Qui peut voir</p>
        {(Object.keys(visibilityConfig) as VisibilityLevel[]).map(level => (
          <DropdownMenuItem
            key={level}
            onClick={() => onChangeVisibility(visKey, level)}
            className={cn(
              "gap-2.5 text-sm rounded-lg mx-1 cursor-pointer",
              currentLevel === level && "bg-primary/10"
            )}
          >
            <span className={visibilityConfig[level].color}>{visibilityConfig[level].icon}</span>
            <span className="flex-1">{visibilityConfig[level].label}</span>
            {currentLevel === level && <Check className="w-3.5 h-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProfileOverview({ profile, isOwnProfile, isFriend, friendsCount, onNavigateToAbout }: ProfileOverviewProps) {
  const { user } = useAuth();
  const updateProfile = useUpdateProfile();
  const queryClient = useQueryClient();

  const visibility: FieldVisibility = profile.field_visibility || {
    date_of_birth: 'public',
    city: 'public',
    education: 'public',
    work: 'public',
    relationship_status: 'public',
    interests: 'public',
  };

  const canSeeField = useCallback((visKey: keyof FieldVisibility) => {
    if (isOwnProfile) return true;
    const level = visibility[visKey] || 'public';
    if (level === 'public') return true;
    if (level === 'friends' && isFriend) return true;
    return false;
  }, [isOwnProfile, isFriend, visibility]);

  const changeVisibility = async (visKey: keyof FieldVisibility, level: VisibilityLevel) => {
    const newVisibility = { ...visibility, [visKey]: level };
    try {
      await updateProfile.mutateAsync({ field_visibility: newVisibility });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      toast({ title: `Visibilité : ${visibilityConfig[level].label}` });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  // Fetch 6 friends for preview
  const { data: friends } = useQuery({
    queryKey: ['profile-friends-preview', profile.user_id],
    queryFn: async () => {
      const { data: friendships } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${profile.user_id},addressee_id.eq.${profile.user_id}`)
        .limit(6);

      if (!friendships || friendships.length === 0) return [];

      const friendIds = friendships.map(f =>
        f.requester_id === profile.user_id ? f.addressee_id : f.requester_id
      );

      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', friendIds);

      return (profiles || []) as ProfileFriend[];
    },
    enabled: !!profile.user_id,
  });

  const infoItems = [
    {
      key: 'city',
      visKey: 'city' as keyof FieldVisibility,
      icon: <MapPin className="w-4 h-4" />,
      label: 'Habite à',
      value: profile.city,
    },
    {
      key: 'date_of_birth',
      visKey: 'date_of_birth' as keyof FieldVisibility,
      icon: <Cake className="w-4 h-4" />,
      label: 'Né(e) le',
      value: profile.date_of_birth ? formatDate(profile.date_of_birth) : null,
    },
    {
      key: 'work',
      visKey: 'work' as keyof FieldVisibility,
      icon: <Briefcase className="w-4 h-4" />,
      label: 'Travaille comme',
      value: profile.work,
    },
    {
      key: 'education',
      visKey: 'education' as keyof FieldVisibility,
      icon: <GraduationCap className="w-4 h-4" />,
      label: 'Études',
      value: profile.education_level
        ? `${profile.education_level}${profile.education_city ? ` à ${profile.education_city}` : ''}`
        : null,
    },
    {
      key: 'relationship_status',
      visKey: 'relationship_status' as keyof FieldVisibility,
      icon: <Heart className="w-4 h-4" />,
      label: 'Situation amoureuse',
      value: profile.relationship_status,
    },
    {
      key: 'interests',
      visKey: 'interests' as keyof FieldVisibility,
      icon: <Sparkles className="w-4 h-4" />,
      label: 'Centres d\'intérêt',
      value: profile.interests && profile.interests.length > 0 ? profile.interests.join(', ') : null,
    },
  ];

  const visibleInfoItems = infoItems.filter(item => canSeeField(item.visKey) && (item.value || isOwnProfile));

  return (
    <div className="space-y-4">
      {/* About summary card */}
      <div className="rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm overflow-hidden">
        <div className="px-5 pt-4 pb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold tracking-tight flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
              <Mail className="w-3.5 h-3.5 text-primary" />
            </div>
            Informations personnelles
          </h3>
          <button
            onClick={onNavigateToAbout}
            className="text-xs text-primary font-medium hover:underline flex items-center gap-0.5"
          >
            Voir tout <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-3 pb-3">
          {visibleInfoItems.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4 italic">Aucune information renseignée</p>
          ) : (
            visibleInfoItems.map((item, idx) => {
              const currentVisLevel = (visibility[item.visKey] || 'public') as VisibilityLevel;
              return (
                <div key={item.key}>
                  <div className="group flex items-center gap-3 px-2 py-2.5 rounded-xl transition-colors hover:bg-secondary/30">
                    <div className={cn(
                      "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0",
                      item.value ? "bg-primary/10 text-primary" : "bg-muted/60 text-muted-foreground"
                    )}>
                      {item.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      {item.value ? (
                        <>
                          <p className="text-sm font-medium text-foreground leading-tight truncate">{item.value}</p>
                          <p className="text-[11px] text-muted-foreground/70">{item.label}</p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground/60 italic">Non renseigné</p>
                      )}
                    </div>
                    {isOwnProfile && (
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                        <VisibilityDropdown
                          visKey={item.visKey}
                          currentLevel={currentVisLevel}
                          visibility={visibility}
                          onChangeVisibility={changeVisibility}
                        />
                      </div>
                    )}
                  </div>
                  {idx < visibleInfoItems.length - 1 && (
                    <div className="mx-4 border-b border-border/15" />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Friends card */}
      <div className="rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm overflow-hidden">
        <div className="px-5 pt-4 pb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold tracking-tight flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
              <Users className="w-3.5 h-3.5 text-primary" />
            </div>
            Amis
            <span className="text-xs font-normal text-muted-foreground ml-1">({friendsCount})</span>
          </h3>
          <Link
            to="/friends"
            className="text-xs text-primary font-medium hover:underline flex items-center gap-0.5"
          >
            Voir tous <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        <div className="px-4 pb-4">
          {!friends || friends.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4 italic">Aucun ami pour le moment</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {friends.map(friend => (
                <div key={friend.user_id} className="flex flex-col items-center gap-1.5 p-2 rounded-xl hover:bg-secondary/30 transition-colors">
                  <Link to={`/profile/${friend.user_id}`} className="w-full">
                    <div className="w-full aspect-square rounded-xl overflow-hidden bg-muted">
                      <UserAvatar
                        src={friend.avatar_url}
                        alt={friend.name}
                        size="xl"
                        className="w-full h-full rounded-xl"
                      />
                    </div>
                  </Link>
                  <Link to={`/profile/${friend.user_id}`}>
                    <p className="text-[11px] font-medium text-center truncate w-full hover:underline">{friend.name}</p>
                  </Link>
                  {user && user.id !== friend.user_id && (
                    <FriendshipButton userId={friend.user_id} showMessage={false} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
