import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Edit2, Camera, MapPin, Briefcase, Link2, Calendar, ChevronDown, Grid3X3, Move, Check, X, Users, FolderOpen, MessageCircle } from 'lucide-react';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { useUserPosts } from '@/hooks/usePosts';
import { useAuth } from '@/lib/auth';
import { AppLayout } from '@/components/AppLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { PostCard } from '@/components/PostCard';
import { FriendshipButton } from '@/components/FriendshipButton';
import { ShareButton } from '@/components/ShareButton';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useNavigate } from 'react-router-dom';
import { useState, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { generateProfileUrl } from '@/lib/urlUtils';
import { useImageUpload } from '@/hooks/useImageUpload';
import { Loader2 } from 'lucide-react';
import { AvatarCropper } from '@/components/AvatarCropper';
import { ProfilePhotoGrid } from '@/components/profile/ProfilePhotoGrid';
import { AlbumsList } from '@/components/profile/AlbumsList';
import { AlbumDetail } from '@/components/profile/AlbumDetail';
import { type Album } from '@/hooks/useAlbums';

export default function Profile() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('all');
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
  const updateProfile = useUpdateProfile();

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
    bucket: 'avatars',
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
      if (!userId) return { postsCount: 0, likesReceived: 0, friendsCount: 0 };
      const [{ count: postsCount }, { data: postIds }, { count: friendsCount }] = await Promise.all([
        supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId),
        supabase.from('posts').select('id').eq('user_id', userId),
        supabase.from('friendships').select('*', { count: 'exact', head: true }).eq('status', 'accepted').or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
      ]);
      let likesReceived = 0;
      if (postIds && postIds.length > 0) {
        const { count } = await supabase.from('likes').select('*', { count: 'exact', head: true }).in('post_id', postIds.map(p => p.id));
        likesReceived = count || 0;
      }
      return { postsCount: postsCount || 0, likesReceived, friendsCount: friendsCount || 0 };
    },
    enabled: !!userId,
  });

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
        <div className="mx-auto max-w-[900px]">
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
        <div className="mx-auto max-w-[900px]">
          <div className="premium-card p-10 text-center mt-8">
            <p className="text-muted-foreground text-sm">Profil non trouvé</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  const tabItems = [
    { value: 'all', label: 'Publications' },
    { value: 'albums', label: 'Albums' },
    { value: 'photos', label: 'Photos' },
    { value: 'reels', label: 'Reels' },
  ];

  return (
    <AppLayout fullWidth>
      <div className="mx-auto max-w-[900px]">
      <div className="-mt-2">
        <input ref={avatarInputRef} type="file" accept="image/*" onChange={handleAvatarChange} className="hidden" />
        <input ref={coverInputRef} type="file" accept="image/*" onChange={handleCoverChange} className="hidden" />

        {/* Cover Photo */}
        <div 
          ref={coverRef}
          className={cn(
            "relative h-52 lg:h-72 bg-gradient-to-br from-primary/20 via-primary/10 to-accent/20 overflow-hidden lg:rounded-b-2xl",
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
            <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-accent/10" />
          )}
          
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
                className="absolute bottom-0 left-0 right-0 glass p-3 flex gap-2 z-20"
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
          
          {/* Header buttons */}
          <div className="absolute top-3 left-3 right-3 flex justify-between items-center z-10">
            {!isOwnProfile && (
              <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-8 w-8 rounded-full glass">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            )}
            <div className="flex-1" />
            {!isRepositioning && (
              <div className="flex gap-1.5">
                <ShareButton
                  url={generateProfileUrl(userId!)}
                  title={`Profil de ${profile?.name || 'utilisateur'}`}
                  text={profile?.bio || undefined}
                  variant="ghost"
                  className="h-8 w-8 rounded-full glass"
                />
                {isOwnProfile && profile.cover_url && (
                  <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full glass" onClick={handleStartReposition}>
                    <Move className="w-4 h-4" />
                  </Button>
                )}
                {isOwnProfile && (
                  <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full glass" onClick={() => coverInputRef.current?.click()} disabled={coverUpload.isUploading}>
                    {coverUpload.isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Profile Header */}
        <div className="px-4 lg:px-6 relative">
          {/* Avatar */}
          <div className="absolute -top-14 lg:-top-16 left-4 lg:left-6">
            <div className="relative">
              <div className="w-28 h-28 lg:w-32 lg:h-32 rounded-full border-4 border-background overflow-hidden bg-background shadow-xl">
                {avatarUpload.isUploading ? (
                  <div className="w-full h-full flex items-center justify-center bg-muted">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : (
                  <UserAvatar src={profile.avatar_url} alt={profile.name} size="xl" className="w-full h-full" />
                )}
              </div>
              {isOwnProfile && (
                <button 
                  className="absolute bottom-1 right-1 w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center border-2 border-background hover:bg-primary/90 transition-all duration-200"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={avatarUpload.isUploading}
                >
                  <Camera className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Name & Stats */}
          <div className="pt-16 lg:pt-20 pb-4">
            <h1 className="text-2xl lg:text-3xl font-bold tracking-tight">{profile.name}</h1>
            
            {/* Stats row */}
            <div className="flex items-center gap-5 mt-2">
              <Link to="/friends" className="text-center hover:opacity-80 transition-opacity">
                <span className="text-base font-bold text-foreground">{stats?.friendsCount || 0}</span>
                <span className="text-sm text-muted-foreground ml-1">amis</span>
              </Link>
              <span className="text-border">•</span>
              <div className="text-center">
                <span className="text-base font-bold text-foreground">{stats?.postsCount || 0}</span>
                <span className="text-sm text-muted-foreground ml-1">posts</span>
              </div>
              <span className="text-border">•</span>
              <div className="text-center">
                <span className="text-base font-bold text-foreground">{stats?.likesReceived || 0}</span>
                <span className="text-sm text-muted-foreground ml-1">j'aime</span>
              </div>
            </div>

            {/* Bio */}
            {profile.bio && (
              <p className="text-muted-foreground mt-2.5 text-sm leading-relaxed">{profile.bio}</p>
            )}

            {/* Quick info */}
            <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4" />
                <span>{profile.city || 'France'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Calendar className="w-4 h-4" />
                <span>Depuis {new Date(profile.created_at).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })}</span>
              </div>
            </div>

            {/* Mutual friends */}
            {mutualFriends && mutualFriends.length > 0 && (
              <div className="flex items-center gap-2 mt-3">
                <div className="flex -space-x-1.5">
                  {mutualFriends.slice(0, 3).map((friend) => (
                    <div key={friend.id} className="w-6 h-6 rounded-full border-2 border-background overflow-hidden">
                      <UserAvatar src={friend.avatar_url} alt={friend.name} size="xs" className="w-full h-full" />
                    </div>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">Amis en commun</span>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3 mt-5">
              {isOwnProfile ? (
                <>
                  <Link to="/settings" className="flex-1">
                    <Button className="w-full rounded-xl h-10 text-sm">
                      <Edit2 className="w-4 h-4 mr-2" />
                      Modifier le profil
                    </Button>
                  </Link>
                  <Button 
                    variant="secondary" 
                    className="flex-1 rounded-xl h-10 text-sm"
                    onClick={() => {
                      setActiveTab('albums');
                      setSelectedAlbum(null);
                    }}
                  >
                    <FolderOpen className="w-4 h-4 mr-2" />
                    Mes albums
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex-1">
                    <FriendshipButton userId={userId!} />
                  </div>
                  <Button variant="secondary" className="flex-1 rounded-xl h-10 text-sm">
                    <MessageCircle className="w-4 h-4 mr-2" />
                    Envoyer un message
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-t border-border/30 mt-2">
          <div className="flex gap-0 overflow-x-auto scrollbar-hide px-2 lg:px-4">
            {tabItems.map((tab) => (
              <button
                key={tab.value}
                onClick={() => {
                  setActiveTab(tab.value);
                  if (tab.value === 'albums') setSelectedAlbum(null);
                }}
                className={cn(
                  'flex-1 min-w-fit px-5 py-3.5 text-sm font-medium text-center transition-all duration-200 border-b-2 whitespace-nowrap',
                  activeTab === tab.value
                    ? 'text-primary border-primary'
                    : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-secondary/40'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content sections */}
        <div className="px-4 lg:px-6 py-5 space-y-4">
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
          
          {activeTab === 'all' && (
            <>
              {/* Info cards */}
              <div className="grid grid-cols-2 gap-2">
                <div className="premium-card p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <MapPin className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium">Localisation</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{profile.city || 'France'}</p>
                </div>
                <div className="premium-card p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Link2 className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium">Lien</span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {profile.website_url ? profile.website_url.replace(/^https?:\/\//, '') : 'pulse.app'}
                  </p>
                </div>
              </div>

              {/* Publications */}
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Publications</h3>
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
              </div>
            </>
          )}
        </div>
      </div>
      </div>

      {avatarToCrop && (
        <AvatarCropper
          isOpen={isCropperOpen}
          onClose={handleCloseCropper}
          imageSrc={avatarToCrop}
          onCropComplete={handleCroppedAvatar}
          isUploading={avatarUpload.isUploading}
          aspectRatio={1}
          title="Recadrer la photo de profil"
        />
      )}
    </AppLayout>
  );
}
