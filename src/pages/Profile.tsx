import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Edit2, Camera, MapPin, Briefcase, Link2, Calendar, ChevronDown, Grid3X3, Move, Check, X, Users } from 'lucide-react';
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

export default function Profile() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('all');
  
  // Cover repositioning state
  const [isRepositioning, setIsRepositioning] = useState(false);
  const [coverPositionY, setCoverPositionY] = useState<number>(50);
  const [isDragging, setIsDragging] = useState(false);
  const coverRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef<number>(0);
  const startPositionRef = useRef<number>(50);
  
  // Avatar cropping state
  const [avatarToCrop, setAvatarToCrop] = useState<string | null>(null);
  const [isCropperOpen, setIsCropperOpen] = useState(false);
  
  const userId = id || user?.id;
  const isOwnProfile = userId === user?.id;

  const { data: profile, isLoading: profileLoading } = useProfile(userId);
  const { data: posts, isLoading: postsLoading } = useUserPosts(userId || '');
  const updateProfile = useUpdateProfile();

  // File input refs
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  // Image upload hooks
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
    bucket: 'avatars', // Using avatars bucket for covers too
    onSuccess: (url) => {
      updateProfile.mutate({ cover_url: url }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['profile', userId] });
        }
      });
    },
  });

  // Handle file selection - now opens cropper instead of direct upload
  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Create a data URL from the file for the cropper
      const reader = new FileReader();
      reader.onload = () => {
        setAvatarToCrop(reader.result as string);
        setIsCropperOpen(true);
      };
      reader.readAsDataURL(file);
    }
    // Reset input
    if (avatarInputRef.current) {
      avatarInputRef.current.value = '';
    }
  };

  const handleCoverChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await coverUpload.upload(file);
      // Reset position when new cover is uploaded
      setCoverPositionY(50);
    }
    // Reset input
    if (coverInputRef.current) {
      coverInputRef.current.value = '';
    }
  };

  // Cover repositioning handlers
  const handleStartReposition = useCallback(() => {
    setIsRepositioning(true);
    setCoverPositionY(profile?.cover_position_y ?? 50);
  }, [profile?.cover_position_y]);

  const handleSavePosition = useCallback(() => {
    // Round to integer as the database column is of type integer
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

  // Handle cropped avatar upload
  const handleCroppedAvatar = useCallback(async (croppedBlob: Blob) => {
    // Convert blob to file for upload
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

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

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

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Get stats
  const { data: stats } = useQuery({
    queryKey: ['profile-stats', userId],
    queryFn: async () => {
      if (!userId) return { postsCount: 0, likesReceived: 0, friendsCount: 0 };

      const [{ count: postsCount }, { data: postIds }, { count: friendsCount }] = await Promise.all([
        supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId),
        supabase.from('posts').select('id').eq('user_id', userId),
        supabase
          .from('friendships')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'accepted')
          .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
      ]);

      let likesReceived = 0;
      if (postIds && postIds.length > 0) {
        const { count } = await supabase
          .from('likes')
          .select('*', { count: 'exact', head: true })
          .in('post_id', postIds.map(p => p.id));
        likesReceived = count || 0;
      }

      return { postsCount: postsCount || 0, likesReceived, friendsCount: friendsCount || 0 };
    },
    enabled: !!userId,
  });

  // Get mutual friends (sample data for display)
  const { data: mutualFriends } = useQuery({
    queryKey: ['mutual-friends', userId],
    queryFn: async () => {
      if (!userId || isOwnProfile) return [];
      
      // Get some friends for display
      const { data } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
        .limit(3);
      
      if (!data) return [];
      
      const friendIds = data.map(f => f.requester_id === userId ? f.addressee_id : f.requester_id);
      
      if (friendIds.length === 0) return [];
      
      const { data: profiles } = await supabase
        .from('profiles')
        .select('*')
        .in('user_id', friendIds)
        .limit(3);
      
      return profiles || [];
    },
    enabled: !!userId && !isOwnProfile,
  });

  if (profileLoading) {
    return (
      <AppLayout>
        <div className="animate-pulse">
          {/* Cover skeleton */}
          <div className="h-40 bg-muted rounded-b-3xl" />
          <div className="px-4 -mt-16">
            <div className="w-28 h-28 rounded-full bg-muted border-4 border-background" />
            <div className="mt-3 space-y-2">
              <div className="h-6 w-48 bg-muted rounded" />
              <div className="h-4 w-32 bg-muted rounded" />
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!profile) {
    return (
      <AppLayout>
        <div className="pulse-card p-8 text-center">
          <p className="text-muted-foreground">Profil non trouvé</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="-mx-4 -mt-4">
        {/* Hidden file inputs */}
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/*"
          onChange={handleAvatarChange}
          className="hidden"
        />
        <input
          ref={coverInputRef}
          type="file"
          accept="image/*"
          onChange={handleCoverChange}
          className="hidden"
        />

        {/* Cover Photo */}
        <div 
          ref={coverRef}
          className={cn(
            "relative h-44 bg-gradient-to-br from-primary/30 via-primary/20 to-accent overflow-hidden",
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
          {/* Cover image or placeholder */}
          {profile.cover_url ? (
            <img 
              src={profile.cover_url} 
              alt="Couverture" 
              className="w-full h-full object-cover select-none"
              style={{ 
                objectPosition: `center ${isRepositioning ? coverPositionY : (profile.cover_position_y ?? 50)}%` 
              }}
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 bg-[url('data:image/svg+xml,%3Csvg%20width%3D%2260%22%20height%3D%2260%22%20viewBox%3D%220%200%2060%2060%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cg%20fill%3D%22none%22%20fill-rule%3D%22evenodd%22%3E%3Cg%20fill%3D%22%239C92AC%22%20fill-opacity%3D%220.08%22%3E%3Cpath%20d%3D%22M36%2034v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6%2034v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6%204V0H4v4H0v2h4v4h2V6h4V4H6z%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E')] opacity-50" />
          )}
          
          {/* Upload overlay when uploading */}
          {coverUpload.isUploading && (
            <div className="absolute inset-0 bg-background/50 flex items-center justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          )}
          
          {/* Repositioning overlay - mobile friendly bottom bar */}
          {isRepositioning && (
            <>
              {/* Instruction overlay */}
              <div className="absolute inset-0 bg-background/20 flex items-center justify-center pointer-events-none">
                <div className="bg-background/90 backdrop-blur-sm rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2 shadow-lg">
                  <Move className="w-4 h-4" />
                  <span className="hidden sm:inline">Glisse pour repositionner</span>
                  <span className="sm:hidden">Glisse ↕</span>
                </div>
              </div>
              
              {/* Mobile-friendly bottom action bar */}
              <div 
                className="absolute bottom-0 left-0 right-0 bg-background/95 backdrop-blur-sm border-t border-border p-3 flex gap-3 z-20"
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
              >
                <Button 
                  variant="outline" 
                  className="flex-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCancelReposition();
                  }}
                >
                  <X className="w-4 h-4 mr-2" />
                  Annuler
                </Button>
                <Button 
                  className="flex-1 bg-primary hover:bg-primary/90"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSavePosition();
                  }}
                  disabled={updateProfile.isPending}
                >
                  {updateProfile.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4 mr-2" />
                  )}
                  Enregistrer
                </Button>
              </div>
            </>
          )}
          
          {/* Header buttons */}
          <div className="absolute top-3 left-3 right-3 flex justify-between items-center z-10">
            {!isOwnProfile && (
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={() => navigate(-1)}
                className="bg-background/80 backdrop-blur-sm hover:bg-background/90"
              >
                <ArrowLeft className="w-5 h-5" />
              </Button>
            )}
            <div className="flex-1" />
            {!isRepositioning && (
              <div className="flex gap-2">
                <ShareButton
                  url={generateProfileUrl(userId!)}
                  title={`Profil de ${profile?.name || 'utilisateur'}`}
                  text={profile?.bio || undefined}
                  variant="ghost"
                  className="bg-background/80 backdrop-blur-sm hover:bg-background/90"
                />
                {isOwnProfile && profile.cover_url && (
                  <Button 
                    variant="ghost" 
                    size="icon"
                    className="bg-background/80 backdrop-blur-sm hover:bg-background/90"
                    onClick={handleStartReposition}
                  >
                    <Move className="w-5 h-5" />
                  </Button>
                )}
                {isOwnProfile && (
                  <Button 
                    variant="ghost" 
                    size="icon"
                    className="bg-background/80 backdrop-blur-sm hover:bg-background/90"
                    onClick={() => coverInputRef.current?.click()}
                    disabled={coverUpload.isUploading}
                  >
                    {coverUpload.isUploading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Camera className="w-5 h-5" />
                    )}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Profile Header */}
        <div className="px-4 relative">
          {/* Avatar */}
          <div className="absolute -top-16 left-4">
            <div className="relative">
              <div className="w-28 h-28 rounded-full border-4 border-background overflow-hidden bg-background">
                {avatarUpload.isUploading ? (
                  <div className="w-full h-full flex items-center justify-center bg-muted">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  </div>
                ) : (
                  <UserAvatar src={profile.avatar_url} alt={profile.name} size="xl" className="w-full h-full" />
                )}
              </div>
              {isOwnProfile && (
                <button 
                  className="absolute bottom-1 right-1 w-8 h-8 bg-secondary rounded-full flex items-center justify-center border-2 border-background hover:bg-secondary/80 transition-colors disabled:opacity-50"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={avatarUpload.isUploading}
                >
                  {avatarUpload.isUploading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Camera className="w-4 h-4" />
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Name & Stats */}
          <div className="pt-16 pb-4">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-bold">{profile.name}</h1>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                  <Link to="/friends" className="hover:underline">
                    <span className="flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" />
                      <strong className="text-foreground">{stats?.friendsCount || 0}</strong> amis
                    </span>
                  </Link>
                  <span>•</span>
                  <span><strong className="text-foreground">{stats?.postsCount || 0}</strong> publications</span>
                  <span>•</span>
                  <span><strong className="text-foreground">{stats?.likesReceived || 0}</strong> j'aime</span>
                </div>
              </div>
              <ChevronDown className="w-6 h-6 text-muted-foreground mt-2" />
            </div>

            {/* Bio */}
            {profile.bio && (
              <p className="text-muted-foreground mt-3 text-sm">{profile.bio}</p>
            )}

            {/* Quick info badges */}
            <div className="flex flex-wrap gap-2 mt-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Briefcase className="w-4 h-4" />
                <span>Création digitale</span>
              </div>
              <span>•</span>
              <div className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4" />
                <span>{profile.city || 'France'}</span>
              </div>
            </div>

            {/* Mutual friends */}
            {mutualFriends && mutualFriends.length > 0 && (
              <div className="flex items-center gap-2 mt-4">
                <div className="flex -space-x-2">
                  {mutualFriends.slice(0, 3).map((friend) => (
                    <div key={friend.id} className="w-8 h-8 rounded-full border-2 border-background overflow-hidden">
                      <UserAvatar src={friend.avatar_url} alt={friend.name} size="sm" className="w-full h-full" />
                    </div>
                  ))}
                  {mutualFriends.length > 3 && (
                    <div className="w-8 h-8 rounded-full border-2 border-background bg-secondary flex items-center justify-center text-xs font-medium">
                      ...
                    </div>
                  )}
                </div>
                <span className="text-sm text-muted-foreground">Ami(e)s avec des points communs</span>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-2 mt-5">
              {isOwnProfile ? (
                <>
                  <Link to="/settings" className="flex-1">
                    <Button className="w-full bg-primary hover:bg-primary/90">
                      <Edit2 className="w-4 h-4 mr-2" />
                      Modifier le profil
                    </Button>
                  </Link>
                  <Button 
                    variant="secondary" 
                    className="flex-1"
                    onClick={() => navigate('/settings')}
                  >
                    <Grid3X3 className="w-4 h-4 mr-2" />
                    Tableau de bord
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex-1">
                    <FriendshipButton userId={userId!} />
                  </div>
                  <Button variant="secondary" className="flex-1">
                    Envoyer un message
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-t border-border">
          <div className="px-4">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className="w-full justify-start bg-transparent h-12 p-0 gap-0">
                <TabsTrigger 
                  value="all" 
                  className={cn(
                    "rounded-full px-4 py-2 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none",
                    "text-muted-foreground"
                  )}
                >
                  Tout
                </TabsTrigger>
                <TabsTrigger 
                  value="reels"
                  className={cn(
                    "rounded-full px-4 py-2 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none",
                    "text-muted-foreground"
                  )}
                >
                  Reels
                </TabsTrigger>
                <TabsTrigger 
                  value="photos"
                  className={cn(
                    "rounded-full px-4 py-2 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none",
                    "text-muted-foreground"
                  )}
                >
                  Photos
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {/* Content sections */}
        <div className="px-4 py-4 space-y-4">
          {/* Photo/Video Grid */}
          {(activeTab === 'photos' || activeTab === 'reels') && (
            <ProfilePhotoGrid userId={userId!} activeTab={activeTab} />
          )}
          {/* Personal Info Section - only show on "all" tab */}
          {activeTab === 'all' && (
            <>
              <div className="pulse-card p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold">Informations personnelles</h3>
                  {isOwnProfile && (
                    <Link to="/settings">
                      <Edit2 className="w-5 h-5 text-muted-foreground hover:text-foreground transition-colors" />
                    </Link>
                  )}
                </div>
                <div className="space-y-3">
                  <div className="flex items-center gap-3 text-sm">
                    <MapPin className="w-5 h-5 text-muted-foreground" />
                    <span>{profile.city || 'France'}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Calendar className="w-5 h-5 text-muted-foreground" />
                    <span>Membre depuis {new Date(profile.created_at).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</span>
                  </div>
                </div>
              </div>

              {/* Links Section */}
              <div className="pulse-card p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold">Liens</h3>
                  {isOwnProfile && (
                    <Link to="/settings">
                      <Edit2 className="w-5 h-5 text-muted-foreground hover:text-foreground transition-colors" />
                    </Link>
                  )}
                </div>
                <div className="space-y-3">
                  <div className="flex items-center gap-3 text-sm">
                    <Link2 className="w-5 h-5 text-muted-foreground" />
                    {profile.website_url ? (
                      <a href={profile.website_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {profile.website_url.replace(/^https?:\/\//, '')}
                      </a>
                    ) : (
                      <a href="#" className="text-primary hover:underline">pulse.app/{profile.name.toLowerCase().replace(/\s+/g, '')}</a>
                    )}
                  </div>
                </div>
              </div>

              {/* Publications */}
              <div>
                <h3 className="font-semibold text-muted-foreground mb-4">Publications</h3>

                {postsLoading ? (
                  <div className="space-y-4">
                    {[1, 2].map((i) => (
                      <div key={i} className="pulse-card p-5 animate-pulse">
                        <div className="h-4 w-full bg-muted rounded" />
                        <div className="h-4 w-2/3 bg-muted rounded mt-2" />
                      </div>
                    ))}
                  </div>
                ) : posts?.length === 0 ? (
                  <div className="pulse-card p-8 text-center">
                    <p className="text-muted-foreground">
                      {isOwnProfile ? "Vous n'avez pas encore publié." : 'Aucune publication.'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {posts?.map((post) => (
                      <PostCard
                        key={post.id}
                        post={post}
                        onCommentClick={() => navigate(`/post/${post.id}`)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Avatar Cropper Dialog */}
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
