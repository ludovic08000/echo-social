import { useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Camera, Check, MessageCircle, Lock, FolderOpen, Newspaper, LogOut, Calendar, ShieldCheck } from 'lucide-react';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { supabase } from '@/integrations/supabase/client';
import { UserAvatar } from '@/components/UserAvatar';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

export function FeedProfileHeader() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { data: profile } = useProfile();
  const updateProfile = useUpdateProfile();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: counts } = useQuery({
    queryKey: ['feed-header-counts', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      if (!user?.id) return { posts: 0, friends: 0 };
      const [postsRes, friendsRes] = await Promise.all([
        supabase
          .from('posts')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id),
        supabase
          .from('friendships')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'accepted')
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`),
      ]);
      return {
        posts: postsRes.count ?? 0,
        friends: friendsRes.count ?? 0,
      };
    },
  });

  if (!user) return null;

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: 'Image trop volumineuse', description: 'Maximum 2 Mo', variant: 'destructive' });
      return;
    }
    try {
      const { uploadToR2 } = await import('@/lib/r2');
      const { url } = await uploadToR2(file, 'avatars');
      await updateProfile.mutateAsync({ avatar_url: url + '?t=' + Date.now() });
      toast({ title: 'Photo mise à jour' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const goFriends = () => navigate('/friends');
  const memberSince = profile?.created_at
    ? format(new Date(profile.created_at), 'MMM yyyy', { locale: fr })
    : null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="px-3 sm:px-4"
      aria-label="Mon profil"
    >
      <div className="relative rounded-[28px] border border-border/30 bg-card/80 backdrop-blur-xl overflow-hidden shadow-[0_18px_50px_-24px_hsl(var(--foreground)/0.22)]">
        {/* Cover */}
        <div className="relative h-32 sm:h-40 w-full overflow-hidden">
          {profile?.cover_url ? (
            <img
              src={profile.cover_url}
              alt=""
              className="w-full h-full object-cover"
              style={{ objectPosition: `center ${profile.cover_position_y ?? 50}%` }}
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-primary/30 via-accent/20 to-primary/10" />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-card/90" />
        </div>

        {/* Body */}
        <div className="px-5 pb-5 -mt-12 relative flex flex-col items-center text-center">
          {/* Avatar */}
          <div className="relative">
            <div className="p-[3px] rounded-full bg-gradient-to-br from-primary via-accent to-primary shadow-[0_10px_30px_-8px_hsl(var(--primary)/0.55)]">
              <div className="rounded-full bg-card p-[2px]">
                <UserAvatar src={profile?.avatar_url} alt={profile?.name} size="xl" className="w-24 h-24" />
              </div>
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              aria-label="Changer la photo"
              className="absolute -left-1 bottom-1 w-8 h-8 rounded-full bg-background/90 border border-border/40 flex items-center justify-center hover:bg-background transition-colors"
            >
              <Camera className="w-3.5 h-3.5 text-foreground" />
            </button>
            {profile?.age_verified && (
              <span
                aria-label="Compte vérifié"
                className="absolute -right-1 bottom-1 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center border-2 border-card"
              >
                <Check className="w-4 h-4" strokeWidth={3} />
              </span>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
          </div>

          {/* Name */}
          <h2
            className="mt-3 text-3xl italic font-semibold tracking-tight"
            style={{ fontFamily: '"Playfair Display", serif' }}
          >
            {profile?.name || 'Mon profil'}
          </h2>

          {/* Mood + protected pill */}
          <div className="mt-1.5 flex items-center gap-2 text-xs">
            {profile?.mood_emoji && <span className="text-lg leading-none">{profile.mood_emoji}</span>}
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
              <ShieldCheck className="w-3 h-3" />
              Compte protégé
            </span>
          </div>

          {/* Stats */}
          <div className="mt-4 w-full max-w-sm rounded-2xl border border-border/40 bg-secondary/30 grid grid-cols-3 divide-x divide-border/40 overflow-hidden">
            <StatCell label="POSTS" value={counts?.posts ?? 0} />
            <StatCell label="AMIS" value={counts?.friends ?? 0} onClick={goFriends} />
            <StatCell label="ABONNEMENTS" value={counts?.friends ?? 0} onClick={goFriends} />
          </div>

          {/* Since */}
          {memberSince && (
            <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-secondary/50 border border-border/30 text-xs text-muted-foreground">
              <Calendar className="w-3 h-3" />
              Depuis {memberSince}
            </div>
          )}

          {/* Actions */}
          <div className="mt-4 flex items-center gap-2 w-full justify-center flex-wrap">
            <button
              onClick={() => navigate('/messages')}
              className="inline-flex items-center gap-1.5 px-4 h-10 rounded-full bg-primary text-primary-foreground text-sm font-medium shadow-[0_8px_24px_-10px_hsl(var(--primary)/0.7)] hover:opacity-90 transition"
            >
              <MessageCircle className="w-4 h-4" />
              Messages
            </button>
            <button
              disabled
              className="inline-flex items-center gap-1.5 px-4 h-10 rounded-full bg-secondary/50 text-muted-foreground text-sm border border-border/30 cursor-not-allowed"
            >
              <Lock className="w-3.5 h-3.5" />
              Tips bientôt
            </button>
            <IconAction label="Albums" onClick={() => navigate('/settings?tab=albums')}>
              <FolderOpen className="w-4 h-4" />
            </IconAction>
            <IconAction label="Mes posts" onClick={() => navigate('/feed')}>
              <Newspaper className="w-4 h-4" />
            </IconAction>
            <IconAction
              label="Déconnexion"
              onClick={async () => { await signOut(); navigate('/'); }}
              className="text-destructive border-destructive/30 hover:bg-destructive/10"
            >
              <LogOut className="w-4 h-4" />
            </IconAction>
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function StatCell({ label, value, onClick }: { label: string; value: number; onClick?: () => void }) {
  const inner = (
    <div className="py-3 px-2">
      <div className="text-lg font-bold leading-none">{value}</div>
      <div className="mt-1 text-[10px] font-medium tracking-[0.14em] text-muted-foreground">{label}</div>
    </div>
  );
  if (onClick) {
    return (
      <button onClick={onClick} className="hover:bg-secondary/40 transition-colors">
        {inner}
      </button>
    );
  }
  return inner;
}

function IconAction({
  children,
  label,
  onClick,
  className,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cn(
        'w-10 h-10 rounded-full bg-secondary/50 border border-border/30 flex items-center justify-center hover:bg-secondary transition-colors',
        className,
      )}
    >
      {children}
    </button>
  );
}
