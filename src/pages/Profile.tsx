import { useParams, Link } from 'react-router-dom';
import { useCustomBackground } from '@/hooks/useCustomBackground';
import { ArrowLeft, Edit2, Camera, MapPin, Briefcase, Link2, Calendar, ChevronDown, Grid3X3, Move, Check, X, Users, FolderOpen, MessageCircle, GraduationCap, Cake, ShieldAlert, Crown, LogOut, Newspaper, Lock, Globe, Eye } from 'lucide-react';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { useUserPosts } from '@/hooks/usePosts';
import { useCreateConversation } from '@/hooks/useMessages';
import { CreatePost } from '@/components/CreatePost';
import { useAuth } from '@/lib/auth';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { PostCard } from '@/components/PostCard';
import { FriendshipButton } from '@/components/FriendshipButton';
import { useFriendshipStatus } from '@/hooks/useFriendships';
import { ShareButton } from '@/components/ShareButton';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useNavigate } from 'react-router-dom';
import { useState, useRef, useCallback, useEffect, lazy, Suspense } from 'react';
import { cn } from '@/lib/utils';
import { generateProfileUrl } from '@/lib/urlUtils';
import { useImageUpload } from '@/hooks/useImageUpload';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Loader2 } from 'lucide-react';
const AvatarCropper = lazy(() => import('@/components/AvatarCropper').then(m => ({ default: m.AvatarCropper })));
import { ProfilePhotoGrid } from '@/components/profile/ProfilePhotoGrid';
import { AlbumsList } from '@/components/profile/AlbumsList';
import { AlbumDetail } from '@/components/profile/AlbumDetail';
import { ProfileFriendsList } from '@/components/profile/ProfileFriendsList';
import { ProfileAboutSection } from '@/components/profile/ProfileAboutSection';
import { ProfileOverview } from '@/components/profile/ProfileOverview';
import { AnonymousWall } from '@/components/profile/AnonymousWall';
import { ProfileMusicPlayer } from '@/components/profile/ProfileMusicPlayer';
import { type Album } from '@/hooks/useAlbums';
import { toast } from '@/hooks/use-toast';
import { CreatorBadge } from '@/components/CreatorBadge';
import { TipButton } from '@/components/TipButton';
import { useIsCreator } from '@/hooks/useCreator';
import { useIsMinor } from '@/hooks/useMinorProtection';
import { MinorProtectedBadge } from '@/components/MinorProtectedBadge';
import { MinorReportButton } from '@/components/MinorReportButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { SEOHead } from '@/components/SEOHead';
import { buildProfileMeta } from '@/lib/seo/buildMeta';

function NoIndexMeta() {
  useEffect(() => {
    let el = document.querySelector('meta[name="robots"]');
    if (!el) { el = document.createElement('meta'); el.setAttribute('name', 'robots'); document.head.appendChild(el); }
    el.setAttribute('content', 'noindex, nofollow');
    return () => { el?.remove(); };
  }, []);
  return null;
}

function ReportFakeAccountButton({ reportedUserId }: { reportedUserId: string }) {

  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const handleReport = async () => {
    if (!user) return;
    setLoading(true);
    try {
      // Check if already reported
      const { data: existing } = await supabase
        .from('identity_verifications')
        .select('id')
        .eq('reported_user_id', reportedUserId)
        .eq('reporter_id', user.id)
        .maybeSingle();

      if (existing) {
        toast({ title: 'Déjà signalé', description: 'Vous avez déjà signalé ce compte.' });
        setOpen(false);
        return;
      }

      const { error } = await supabase.from('identity_verifications').insert({
        reported_user_id: reportedUserId,
        reporter_id: user.id,
        reason: reason.trim() || 'fake_account',
      });
      if (error) throw error;

      toast({ title: '✅ Signalement envoyé', description: 'Ce compte devra vérifier son identité sous 72h.' });
      setOpen(false);
      setReason('');
    } catch (e: any) {
      toast({ title: 'Erreur', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="icon" className="rounded-xl h-10 w-10 shrink-0 text-destructive hover:bg-destructive/10" onClick={() => setOpen(true)}>
        <ShieldAlert className="w-4 h-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Signaler un faux compte</DialogTitle>
            <DialogDescription>
              Ce compte sera invité à vérifier son identité avec une pièce d'identité. Sans vérification sous 72h, le compte sera supprimé automatiquement.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Pourquoi pensez-vous que c'est un faux compte ? (optionnel)"
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
          />
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
            <Button variant="destructive" onClick={handleReport} disabled={loading}>
              {loading ? 'Envoi...' : 'Signaler comme faux compte'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Profile() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedAlbum, setSelectedAlbum] = useState<Album | null>(null);
  
  const [isRepositioning, setIsRepositioning] = useState(false);
  const [coverPositionY, setCoverPositionY] = useState<number>(50);
  const [isDragging, setIsDragging] = useState(false);
  const coverRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef<number>(0);
  const startPositionRef = useRef<number>(50);
  
  const [avatarToCrop, setAvatarToCrop] = useState<string | null>(null);
  const [isCropperOpen, setIsCropperOpen] = useState(false);
  
  const userId = id || user?.id;
  const isOwnProfile = userId === user?.id;

  const { data: profile, isLoading: profileLoading } = useProfile(userId);
  const { data: posts, isLoading: postsLoading } = useUserPosts(userId || '');
  const { data: friendshipData } = useFriendshipStatus(userId || '');
  const { data: isCreator } = useIsCreator(userId);
  const { data: targetIsMinor } = useIsMinor(userId);
  const { data: currentUserIsMinor } = useIsMinor(user?.id);
  const updateProfile = useUpdateProfile();
  const createConversation = useCreateConversation();
  const profileBgStyle = useCustomBackground('profile');

  const isFriend = friendshipData?.status === 'accepted';

  // Fetch target user's privacy settings for post visibility
  const { data: targetPrivacy } = useQuery({
    queryKey: ['target-privacy', userId],
    queryFn: async () => {
      if (!userId) return null;
      const { data } = await supabase
        .from('privacy_settings')
        .select('posts_visibility, profile_visibility, wall_visibility')
        .eq('user_id', userId)
        .maybeSingle();
      return data;
    },
    enabled: !!userId,
    staleTime: 5 * 60_000,
  });

  // posts_visibility: 'public' (tout le monde), 'friends' (amis), 'private' (moi seul)
  const postsVis = targetPrivacy?.posts_visibility || 'public';
  const canViewPosts = isOwnProfile || postsVis === 'public' || (postsVis === 'friends' && isFriend);
  const isPrivateProfile = postsVis !== 'public';

  // Check if own profile has pending identity verification
  const { data: pendingVerification } = useQuery({
    queryKey: ['my-verification', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data } = await supabase
        .from('identity_verifications')
        .select('id, status, deadline_at, reason')
        .eq('reported_user_id', user.id)
        .eq('status', 'pending_verification')
        .maybeSingle();
      return data;
    },
    enabled: !!user && isOwnProfile,
  });

  const [idFile, setIdFile] = useState<File | null>(null);
  const [uploadingId, setUploadingId] = useState(false);
  const idInputRef = useRef<HTMLInputElement>(null);

  const handleIdUpload = async () => {
    if (!idFile || !user || !pendingVerification) return;
    setUploadingId(true);
    try {
      // SECURITY FIX: Upload to private Supabase bucket instead of public R2
      const fileName = `${user.id}/${Date.now()}-${idFile.name}`;
      const { error: uploadError } = await supabase.storage
        .from('id-documents')
        .upload(fileName, idFile, { upsert: true });
      if (uploadError) throw uploadError;
      // Store path only (not a public URL) — admin uses signed URL to view
      await supabase.from('identity_verifications').update({
        id_document_url: fileName,
        status: 'document_submitted',
        updated_at: new Date().toISOString(),
      }).eq('id', pendingVerification.id);
      toast({ title: '✅ Document envoyé', description: 'Votre pièce d\'identité est en cours de vérification.' });
      setIdFile(null);
      queryClient.invalidateQueries({ queryKey: ['my-verification'] });
    } catch (e: any) {
      toast({ title: 'Erreur', description: e.message, variant: 'destructive' });
    } finally {
      setUploadingId(false);
    }
  };

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const avatarUpload = useImageUpload({
    bucket: 'avatars',
    onSuccess: (url) => {
      updateProfile.mutate({ avatar_url: url }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['profile', userId] });
          setIsCropperOpen(false);
          setAvatarToCrop(null);
        }
      });
    },
  });

  const coverUpload = useImageUpload({
    bucket: 'images',
    maxSizeMB: 10,
    onSuccess: (url) => {
      updateProfile.mutate({ cover_url: url }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['profile', userId] });
        }
      });
    },
  });

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        setAvatarToCrop(reader.result as string);
        setIsCropperOpen(true);
      };
      reader.readAsDataURL(file);
    }
    if (avatarInputRef.current) avatarInputRef.current.value = '';
  };

  const handleCoverChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await coverUpload.upload(file);
      setCoverPositionY(50);
    }
    if (coverInputRef.current) coverInputRef.current.value = '';
  };

  const handleStartReposition = useCallback(() => {
    setIsRepositioning(true);
    setCoverPositionY(profile?.cover_position_y ?? 50);
  }, [profile?.cover_position_y]);

  const handleSavePosition = useCallback(() => {
    updateProfile.mutate({ cover_position_y: Math.round(coverPositionY) }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['profile', userId] });
        setIsRepositioning(false);
      }
    });
  }, [coverPositionY, updateProfile, queryClient, userId]);

  const handleCancelReposition = useCallback(() => {
    setIsRepositioning(false);
    setCoverPositionY(profile?.cover_position_y ?? 50);
  }, [profile?.cover_position_y]);

  const handleCroppedAvatar = useCallback(async (croppedBlob: Blob) => {
    const file = new File([croppedBlob], 'avatar.jpg', { type: 'image/jpeg' });
    await avatarUpload.upload(file);
  }, [avatarUpload]);

  const handleCloseCropper = useCallback(() => {
    setIsCropperOpen(false);
    setAvatarToCrop(null);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isRepositioning) return;
    e.preventDefault();
    setIsDragging(true);
    startYRef.current = e.clientY;
    startPositionRef.current = coverPositionY;
  }, [isRepositioning, coverPositionY]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || !coverRef.current) return;
    const deltaY = e.clientY - startYRef.current;
    const containerHeight = coverRef.current.offsetHeight;
    const deltaPercent = (deltaY / containerHeight) * 100;
    const newPosition = Math.min(100, Math.max(0, startPositionRef.current + deltaPercent));
    setCoverPositionY(newPosition);
  }, [isDragging]);

  const handleMouseUp = useCallback(() => { setIsDragging(false); }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!isRepositioning) return;
    setIsDragging(true);
    startYRef.current = e.touches[0].clientY;
    startPositionRef.current = coverPositionY;
  }, [isRepositioning, coverPositionY]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging || !coverRef.current) return;
    const deltaY = e.touches[0].clientY - startYRef.current;
    const containerHeight = coverRef.current.offsetHeight;
    const deltaPercent = (deltaY / containerHeight) * 100;
    const newPosition = Math.min(100, Math.max(0, startPositionRef.current + deltaPercent));
    setCoverPositionY(newPosition);
  }, [isDragging]);

  const handleTouchEnd = useCallback(() => { setIsDragging(false); }, []);

  const { data: stats } = useQuery({
    queryKey: ['profile-stats', userId],
    queryFn: async () => {
      if (!userId) return { postsCount: 0, likesReceived: 0, friendsCount: 0, followersCount: 0, followingCount: 0 };
      const [
        { count: postsCount },
        { data: postIds },
        { count: friendsCount },
      ] = await Promise.all([
        supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId),
        supabase.from('posts').select('id').eq('user_id', userId),
        // Amitiés mutuelles : on compte tous les liens acceptés peu importe qui a initié
        supabase.from('friendships').select('*', { count: 'exact', head: true }).eq('status', 'accepted').or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
      ]);
      let likesReceived = 0;
      if (postIds && postIds.length > 0) {
        const { count } = await supabase.from('likes').select('*', { count: 'exact', head: true }).in('post_id', postIds.map(p => p.id));
        likesReceived = count || 0;
      }
      return {
        postsCount: postsCount || 0,
        likesReceived,
        friendsCount: friendsCount || 0,
        followersCount: friendsCount || 0,
        followingCount: friendsCount || 0,
      };
    },
    enabled: !!userId,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  // Realtime: invalider les stats à chaque changement
  useEffect(() => {
    if (!userId) return;
    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['profile-stats', userId] });
    const channel = supabase
      .channel(`profile-stats-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'posts', filter: `user_id=eq.${userId}` }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships', filter: `requester_id=eq.${userId}` }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships', filter: `addressee_id=eq.${userId}` }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'likes' }, invalidate)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [userId, queryClient]);

  const { data: mutualFriends } = useQuery({
    queryKey: ['mutual-friends', userId],
    queryFn: async () => {
      if (!userId || isOwnProfile) return [];
      const { data } = await supabase.from('friendships').select('requester_id, addressee_id').eq('status', 'accepted').or(`requester_id.eq.${userId},addressee_id.eq.${userId}`).limit(3);
      if (!data) return [];
      const friendIds = data.map(f => f.requester_id === userId ? f.addressee_id : f.requester_id);
      if (friendIds.length === 0) return [];
      const { data: profiles } = await supabase.from('profiles').select('*').in('user_id', friendIds).limit(3);
      return profiles || [];
    },
    enabled: !!userId && !isOwnProfile,
  });

  if (profileLoading) {
    return (
      <AppLayout fullWidth>
        <div className="w-full px-2 md:px-6">
          <div className="animate-pulse">
            <div className="h-52 bg-muted rounded-b-2xl" />
            <div className="px-6 -mt-14">
              <div className="w-28 h-28 rounded-full bg-muted border-4 border-background" />
              <div className="mt-3 space-y-2">
                <div className="h-6 w-48 bg-muted rounded-lg" />
                <div className="h-4 w-32 bg-muted rounded-lg" />
              </div>
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!profile) {
    return (
      <AppLayout fullWidth>
        <div className="w-full px-2 md:px-6">
          <div className="premium-card p-10 text-center mt-8">
            <p className="text-muted-foreground text-sm">Profil non trouvé</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  const tabItems = [
    { value: 'overview', label: 'Tout' },
    { value: 'all', label: 'Publications' },
    { value: 'about', label: 'À propos' },
    { value: 'albums', label: 'Albums' },
    { value: 'photos', label: 'Photos' },
    { value: 'reels', label: 'Reels' },
  ];

  return (
    <AppLayout fullWidth>
      {!isPrivateProfile && profile && (() => {
        const meta = buildProfileMeta({
          username: (profile as any).username,
          name: profile.name,
          bio: profile.bio,
          avatarUrl: profile.avatar_url,
          city: (profile as any).city,
        });
        return (
          <SEOHead
            title={meta.title}
            description={meta.description}
            image={meta.image}
            url={meta.url}
            type="profile"
            jsonLd={meta.jsonLd}
          />
        );
      })()}
      {isPrivateProfile && <NoIndexMeta />}
      {profileBgStyle && (
        <div className="fixed inset-0 -z-10 opacity-30" style={profileBgStyle} />
      )}
      <div className="w-full px-2 md:px-6">
      <div className="-mt-2">
        <input ref={avatarInputRef} type="file" accept="image/*" onChange={handleAvatarChange} className="hidden" />
        <input ref={coverInputRef} type="file" accept="image/*" onChange={handleCoverChange} className="hidden" />
        <input ref={idInputRef} type="file" accept="image/*,.pdf" onChange={e => setIdFile(e.target.files?.[0] || null)} className="hidden" />

        {/* Identity verification banner */}
        {isOwnProfile && pendingVerification && (
          <div className="mx-4 mt-2 mb-2 p-4 rounded-xl bg-destructive/10 border border-destructive/30">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <p className="text-sm font-semibold text-destructive">Vérification d'identité requise</p>
                <p className="text-xs text-muted-foreground">
                  Votre compte a été signalé. Veuillez fournir une pièce d'identité avant le{' '}
                  <strong>{format(new Date(pendingVerification.deadline_at), 'dd/MM/yyyy à HH:mm', { locale: fr })}</strong>.
                  Sans vérification, votre compte sera supprimé automatiquement.
                </p>
                <div className="flex items-center gap-2">
                  {idFile ? (
                    <>
                      <span className="text-xs text-foreground">{idFile.name}</span>
                      <Button size="sm" className="h-7 text-xs" onClick={handleIdUpload} disabled={uploadingId}>
                        {uploadingId ? 'Envoi...' : 'Envoyer le document'}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => idInputRef.current?.click()}>
                      📎 Joindre ma pièce d'identité
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ============= MODERN PROFILE HEADER (Elite Glassmorphism) ============= */}
        <div className="relative">
          {/* Cover — full bleed, properly framed, taller for breathing room */}
          <div
            ref={coverRef}
            className={cn(
              "relative h-56 sm:h-64 lg:h-80 overflow-hidden lg:rounded-b-3xl",
              isRepositioning && "cursor-ns-resize"
            )}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {profile.cover_url ? (
              <img
                src={profile.cover_url}
                alt="Couverture"
                className="w-full h-full object-cover select-none"
                style={{ objectPosition: `center ${isRepositioning ? coverPositionY : (profile.cover_position_y ?? 50)}%` }}
                draggable={false}
              />
            ) : (
              <>
                <div className="absolute inset-0 bg-gradient-to-br from-[#002395]/40 via-background to-[#ED2939]/30" />
                <div className="absolute inset-0 opacity-30 mix-blend-overlay" style={{
                  backgroundImage: 'radial-gradient(circle at 20% 20%, hsl(var(--primary)/0.5), transparent 50%), radial-gradient(circle at 80% 80%, hsl(var(--accent)/0.4), transparent 50%)'
                }} />
              </>
            )}
            {/* Soft bottom fade so the avatar reads cleanly over any image */}
            <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-background pointer-events-none" />

            {coverUpload.isUploading && (
              <div className="absolute inset-0 bg-background/50 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            )}

            {isRepositioning && (
              <>
                <div className="absolute inset-0 bg-background/20 flex items-center justify-center pointer-events-none">
                  <div className="glass rounded-xl px-4 py-2 text-xs font-medium flex items-center gap-2">
                    <Move className="w-3.5 h-3.5" />
                    <span>Glisse pour repositionner</span>
                  </div>
                </div>
                <div
                  className="absolute bottom-0 left-0 right-0 glass p-3 flex gap-2 z-30"
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                >
                  <Button variant="outline" size="sm" className="flex-1 rounded-xl" onClick={(e) => { e.stopPropagation(); handleCancelReposition(); }}>
                    <X className="w-3.5 h-3.5 mr-1.5" /> Annuler
                  </Button>
                  <Button size="sm" className="flex-1 rounded-xl" onClick={(e) => { e.stopPropagation(); handleSavePosition(); }} disabled={updateProfile.isPending}>
                    {updateProfile.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
                    Enregistrer
                  </Button>
                </div>
              </>
            )}

            {/* Top toolbar */}
            <div className="absolute top-3 left-3 right-3 flex justify-between items-center z-20">
              {!isOwnProfile ? (
                <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-9 w-9 rounded-full bg-background/40 backdrop-blur-xl border border-border/40">
                  <ArrowLeft className="w-4 h-4" />
                </Button>
              ) : <div />}
              {!isRepositioning && (
                <div className="flex gap-1.5">
                  <ShareButton
                    url={generateProfileUrl(userId!)}
                    title={`Profil de ${profile?.name || 'utilisateur'}`}
                    text={profile?.bio || undefined}
                    variant="ghost"
                    className="h-9 w-9 rounded-full bg-background/40 backdrop-blur-xl border border-border/40"
                  />
                  {isOwnProfile && profile.cover_url && (
                    <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full bg-background/40 backdrop-blur-xl border border-border/40" onClick={handleStartReposition}>
                      <Move className="w-4 h-4" />
                    </Button>
                  )}
                  {isOwnProfile && (
                    <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full bg-background/40 backdrop-blur-xl border border-border/40" onClick={() => coverInputRef.current?.click()} disabled={coverUpload.isUploading}>
                      {coverUpload.isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Centered profile card pulled up over cover */}
          <div className="px-4 lg:px-6 -mt-20 lg:-mt-24 relative z-10 flex flex-col items-center text-center">
            {/* Avatar XXL with static tricolor ring (no rotation) */}
            <div className="relative">
              <div
                className="rounded-full p-[3px]"
                style={{
                  background: 'conic-gradient(from 220deg, #002395, #ED2939, #ffffff, #002395)',
                }}
              >
                <div className="rounded-full p-1 bg-background">
                  <div className="w-28 h-28 lg:w-32 lg:h-32 rounded-full overflow-hidden bg-background shadow-2xl">
                    {avatarUpload.isUploading ? (
                      <div className="w-full h-full flex items-center justify-center bg-muted">
                        <Loader2 className="w-6 h-6 animate-spin text-primary" />
                      </div>
                    ) : (
                      <UserAvatar src={profile.avatar_url} alt={profile.name} size="xl" className="w-full h-full" />
                    )}
                  </div>
                </div>
              </div>
              {isCreator && (
                <div className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-[#002395] flex items-center justify-center border-[3px] border-background shadow-lg">
                  <Check className="w-4 h-4 text-white" strokeWidth={3} />
                </div>
              )}
              {isOwnProfile && (
                <button
                  className="absolute bottom-1 left-1 w-8 h-8 bg-foreground text-background rounded-full flex items-center justify-center border-2 border-background hover:scale-110 transition-transform shadow-lg"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={avatarUpload.isUploading}
                  aria-label="Changer la photo de profil"
                >
                  <Camera className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Name + badges */}
            <div className="mt-5 flex flex-col items-center gap-1.5">
              <h1
                className="text-3xl lg:text-4xl font-bold tracking-tight"
                style={{ fontFamily: "'Playfair Display', serif", fontStyle: 'italic' }}
              >
                {profile.name}
              </h1>
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {(profile as any).username && (
                  <span className="text-xs text-muted-foreground font-medium">@{(profile as any).username}</span>
                )}
                {isCreator && <CreatorBadge size="sm" />}
                {targetIsMinor && <MinorProtectedBadge />}
              </div>
            </div>

            {/* Tactile stats glass bar — Insta-style: Posts / Followers / Following */}
            <div className="mt-6 w-full max-w-md flex items-stretch bg-card/40 backdrop-blur-2xl border border-border/40 rounded-3xl p-1 shadow-[0_18px_50px_-24px_hsl(var(--foreground)/0.25)]">
              <div className="flex-1 flex flex-col items-center justify-center py-3 rounded-2xl">
                <span className="text-lg font-bold tracking-tight">{stats?.postsCount || 0}</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-[0.18em] font-semibold mt-0.5">Posts</span>
              </div>
              <div className="w-px bg-border/50 my-2" />
              <Link to="/friends?tab=followers" className="flex-1 flex flex-col items-center justify-center py-3 rounded-2xl transition-all active:scale-95 hover:bg-accent/40">
                <span className="text-lg font-bold tracking-tight">{stats?.followersCount || 0}</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-[0.18em] font-semibold mt-0.5">Followers</span>
              </Link>
              <div className="w-px bg-border/50 my-2" />
              <Link to="/friends?tab=following" className="flex-1 flex flex-col items-center justify-center py-3 rounded-2xl transition-all active:scale-95 hover:bg-accent/40">
                <span className="text-lg font-bold tracking-tight">{stats?.followingCount || 0}</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-[0.18em] font-semibold mt-0.5">Abonnements</span>
              </Link>
            </div>

            {/* Bio */}
            {profile.bio && (
              <p className="text-sm text-foreground/80 leading-relaxed mt-5 max-w-md font-light">
                {profile.bio}
              </p>
            )}

            {/* Quick info pills */}
            <div className="flex flex-wrap items-center justify-center gap-2 mt-4 text-xs text-muted-foreground">
              {profile.city && (
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card/50 border border-border/40">
                  <MapPin className="w-3 h-3" /><span>{profile.city}</span>
                </div>
              )}
              {profile.date_of_birth && (
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card/50 border border-border/40">
                  <Cake className="w-3 h-3" />
                  <span>{new Date(profile.date_of_birth).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                </div>
              )}
              {profile.education_level && (
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card/50 border border-border/40">
                  <GraduationCap className="w-3 h-3" />
                  <span>{profile.education_level}{profile.education_city ? ` · ${profile.education_city}` : ''}</span>
                </div>
              )}
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card/50 border border-border/40">
                <Calendar className="w-3 h-3" />
                <span>Depuis {new Date(profile.created_at).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })}</span>
              </div>
            </div>

            {/* Mutual friends */}
            {mutualFriends && mutualFriends.length > 0 && (
              <div className="flex items-center gap-2 mt-4">
                <div className="flex -space-x-2">
                  {mutualFriends.slice(0, 3).map((friend) => (
                    <div key={friend.id} className="w-7 h-7 rounded-full border-2 border-background overflow-hidden">
                      <UserAvatar src={friend.avatar_url} alt={friend.name} size="xs" className="w-full h-full" />
                    </div>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">Amis en commun</span>
              </div>
            )}

            {/* Premium action buttons */}
            <div className="flex flex-wrap gap-2 mt-6 justify-center w-full max-w-md">
              {isOwnProfile ? (
                <>
                  <Link to="/settings" className="flex-1 min-w-[140px]">
                    <Button className="w-full rounded-2xl h-11 text-sm font-semibold bg-foreground text-background hover:bg-foreground/90">
                      <Edit2 className="w-4 h-4 mr-2" />
                      Modifier
                    </Button>
                  </Link>
                  {!isCreator && (
                    <Link to="/creator" className="flex-1 min-w-[120px]">
                      <Button
                        variant="outline"
                        className="w-full rounded-2xl h-11 text-sm font-semibold border-amber-500/40 text-amber-500 hover:bg-amber-500/10"
                      >
                        <Crown className="w-4 h-4 mr-1.5" />
                        Créateur
                      </Button>
                    </Link>
                  )}
                  {isCreator && <TipButton creatorId={userId!} creatorName={profile.name} />}
                  <Button
                    variant="ghost"
                    className="rounded-2xl h-11 w-11 p-0 bg-card/50 border border-border/40 backdrop-blur-xl"
                    onClick={() => { setActiveTab('albums'); setSelectedAlbum(null); }}
                    aria-label="Mes albums"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </Button>
                  <Link to="/feed">
                    <Button variant="ghost" className="rounded-2xl h-11 w-11 p-0 bg-card/50 border border-border/40 backdrop-blur-xl" aria-label="Fil d'actu">
                      <Newspaper className="w-4 h-4" />
                    </Button>
                  </Link>
                  <Button
                    variant="ghost"
                    className="rounded-2xl h-11 w-11 p-0 bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20"
                    onClick={async () => {
                      await supabase.auth.signOut();
                      navigate('/login');
                    }}
                    aria-label="Déconnexion"
                  >
                    <LogOut className="w-4 h-4" />
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex-1 min-w-[140px]"><FriendshipButton userId={userId!} /></div>
                  <Button
                    className="flex-1 min-w-[140px] rounded-2xl h-11 text-sm font-semibold bg-[#002395] text-white hover:bg-[#002395]/90"
                    disabled={createConversation.isPending}
                    onClick={async () => {
                      if (!userId) return;
                      const conv = await createConversation.mutateAsync(userId);
                      navigate(`/messages/${conv.id}`);
                    }}
                  >
                    <MessageCircle className="w-4 h-4 mr-2" />
                    Message
                  </Button>
                  {isCreator && <TipButton creatorId={userId!} creatorName={profile.name} />}
                  <ReportFakeAccountButton reportedUserId={userId!} />
                  {currentUserIsMinor && <MinorReportButton reportedUserId={userId!} />}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Segmented tabs — sticky, glass, red glow underline */}
        <div className="sticky top-0 z-20 mt-8 bg-background/70 backdrop-blur-2xl border-y border-border/30">
          <div className="flex gap-0 overflow-x-auto scrollbar-hide px-2 lg:px-4">
            {tabItems.map((tab) => {
              const isActive = activeTab === tab.value;
              return (
                <button
                  key={tab.value}
                  onClick={() => {
                    setActiveTab(tab.value);
                    if (tab.value === 'albums') setSelectedAlbum(null);
                  }}
                  className={cn(
                    'relative flex-1 min-w-fit px-5 py-3.5 text-[11px] font-bold uppercase tracking-[0.18em] text-center transition-all whitespace-nowrap',
                    isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {tab.label}
                  {isActive && (
                    <span
                      className="absolute left-1/2 -translate-x-1/2 bottom-1 h-[3px] w-8 rounded-full bg-[#ED2939]"
                      style={{ boxShadow: '0 0 12px hsl(355 86% 51% / 0.6)' }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Content sections */}
        <div className="px-4 lg:px-6 py-5">
          {activeTab === 'overview' && (
            <div className="flex flex-col lg:flex-row gap-4">
              {/* Sidebar - infos & amis */}
              <div className="lg:w-[340px] lg:flex-shrink-0 space-y-4">
                <ProfileOverview
                  profile={profile}
                  isOwnProfile={isOwnProfile}
                  isFriend={friendshipData?.status === 'accepted'}
                  friendsCount={stats?.friendsCount || 0}
                  onNavigateToAbout={() => setActiveTab('about')}
                />
                {/* Profile Music */}
                {profile.profile_music_url && (
                  <ProfileMusicPlayer musicUrl={profile.profile_music_url} profileName={profile.name} />
                )}
                {/* Anonymous Wall */}
                <AnonymousWall
                  targetUserId={userId!}
                  isOwnProfile={isOwnProfile}
                  wallVisibility={(targetPrivacy as any)?.wall_visibility || 'friends'}
                  isFriend={isFriend}
                />
              </div>

              {/* Main - publications */}
              <div className="flex-1 min-w-0 space-y-3">
                {isOwnProfile && (
                  <div className="bg-card border border-border/20 rounded-xl p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Eye className="w-4 h-4" />
                      <span>Qui voit mes publications ?</span>
                    </div>
                    <div className="flex gap-1">
                      {([
                        { value: 'public', label: 'Tous', icon: Globe },
                        { value: 'friends', label: 'Amis', icon: Users },
                        { value: 'private', label: 'Moi', icon: Lock },
                      ] as const).map(opt => (
                        <button
                          key={opt.value}
                          onClick={async () => {
                            await supabase
                              .from('privacy_settings')
                              .update({ posts_visibility: opt.value })
                              .eq('user_id', user!.id);
                            queryClient.invalidateQueries({ queryKey: ['target-privacy', userId] });
                            toast({ title: `Publications : ${opt.label}` });
                          }}
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                            postsVis === opt.value
                              ? 'bg-primary text-primary-foreground shadow-sm'
                              : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'
                          )}
                        >
                          <opt.icon className="w-3.5 h-3.5" />
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {!canViewPosts ? (
                  <div className="premium-card p-8 text-center">
                    <Lock className="w-8 h-8 mx-auto mb-3 text-muted-foreground" />
                    <p className="text-muted-foreground text-sm font-medium">
                      {postsVis === 'private' ? 'Publications masquées' : 'Compte privé'}
                    </p>
                    <p className="text-muted-foreground/70 text-xs mt-1">
                      {postsVis === 'private'
                        ? 'Cet utilisateur a choisi de masquer ses publications.'
                        : 'Ajoutez cette personne en ami pour voir ses publications.'}
                    </p>
                  </div>
                ) : (
                <>
                {isOwnProfile && <CreatePost />}
                {postsLoading ? (
                  <div className="space-y-2">
                    {[1, 2].map((i) => (
                      <div key={i} className="bg-card rounded-xl p-4 animate-pulse">
                        <div className="h-3 w-full bg-muted rounded-lg" />
                        <div className="h-3 w-2/3 bg-muted rounded-lg mt-2" />
                      </div>
                    ))}
                  </div>
                ) : posts?.length === 0 ? (
                  <div className="premium-card p-8 text-center">
                    <p className="text-muted-foreground text-xs">
                      {isOwnProfile ? "Vous n'avez pas encore publié." : 'Aucune publication.'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {posts?.map((post) => (
                      <PostCard key={post.id} post={post} onCommentClick={() => navigate(`/post/${post.id}`)} />
                    ))}
                  </div>
                )}
                </>
                )}
              </div>
            </div>
          )}

          {(activeTab === 'photos' || activeTab === 'reels') && (
            <ProfilePhotoGrid userId={userId!} activeTab={activeTab} />
          )}
          
          {activeTab === 'albums' && (
            selectedAlbum ? (
              <AlbumDetail album={selectedAlbum} isOwnProfile={isOwnProfile} onBack={() => setSelectedAlbum(null)} />
            ) : (
              <AlbumsList userId={userId!} isOwnProfile={isOwnProfile} onSelectAlbum={setSelectedAlbum} />
            )
          )}
          
          {activeTab === 'about' && (
            <div className="max-w-lg space-y-4">
              <ProfileAboutSection
                profile={profile}
                isOwnProfile={isOwnProfile}
                isFriend={friendshipData?.status === 'accepted'}
              />
              <ProfileFriendsList userId={userId!} />
            </div>
          )}

          {activeTab === 'all' && (
            <div className="max-w-lg mx-auto space-y-3">
              {!canViewPosts ? (
                <div className="premium-card p-8 text-center">
                  <Lock className="w-8 h-8 mx-auto mb-3 text-muted-foreground" />
                  <p className="text-muted-foreground text-sm font-medium">
                    {postsVis === 'private' ? 'Publications masquées' : 'Compte privé'}
                  </p>
                  <p className="text-muted-foreground/70 text-xs mt-1">
                    {postsVis === 'private'
                      ? 'Cet utilisateur a choisi de masquer ses publications.'
                      : 'Ajoutez cette personne en ami pour voir ses publications.'}
                  </p>
                </div>
              ) : (
              <>
              {isOwnProfile && <CreatePost />}
              {postsLoading ? (
                <div className="space-y-2">
                  {[1, 2].map((i) => (
                    <div key={i} className="bg-card rounded-xl p-4 animate-pulse">
                      <div className="h-3 w-full bg-muted rounded-lg" />
                      <div className="h-3 w-2/3 bg-muted rounded-lg mt-2" />
                    </div>
                  ))}
                </div>
              ) : posts?.length === 0 ? (
                <div className="premium-card p-8 text-center">
                  <p className="text-muted-foreground text-xs">
                    {isOwnProfile ? "Vous n'avez pas encore publié." : 'Aucune publication.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {posts?.map((post) => (
                    <PostCard key={post.id} post={post} onCommentClick={() => navigate(`/post/${post.id}`)} />
                  ))}
                </div>
              )}
              </>
              )}
            </div>
          )}
        </div>
      </div>
      </div>

      {avatarToCrop && (
        <Suspense fallback={null}>
          <AvatarCropper
            isOpen={isCropperOpen}
            onClose={handleCloseCropper}
            imageSrc={avatarToCrop}
            onCropComplete={handleCroppedAvatar}
            isUploading={avatarUpload.isUploading}
            aspectRatio={1}
            title="Recadrer la photo de profil"
          />
        </Suspense>
      )}
    </AppLayout>
  );
}
