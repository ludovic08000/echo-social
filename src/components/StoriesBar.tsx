import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X, Eye, Trash2, ChevronLeft, ChevronRight, Heart, ChevronUp } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { useStories, useCreateStory, useViewStory, useDeleteStory, useLikeStory, useStoryViewers, GroupedStories } from '@/hooks/useStories';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { Link } from 'react-router-dom';

const STORY_DURATION = 5000; // 5 seconds per story

export function StoriesBar() {
  const { data: groupedStories, isLoading } = useStories();
  const { user } = useAuth();
  const [selectedGroup, setSelectedGroup] = useState<GroupedStories | null>(null);
  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);
  const createStory = useCreateStory();
  const viewStory = useViewStory();
  const deleteStory = useDeleteStory();
  const likeStory = useLikeStory();

  const currentStory = selectedGroup?.stories[currentStoryIndex];
  const isOwner = currentStory?.user_id === user?.id;

  const { data: viewers } = useStoryViewers(isOwner && showViewers ? currentStory?.id ?? null : null);

  // Auto-advance timer
  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    startTimeRef.current = Date.now();
    elapsedRef.current = 0;

    timerRef.current = setInterval(() => {
      const elapsed = elapsedRef.current + (Date.now() - startTimeRef.current);
      const pct = Math.min(elapsed / STORY_DURATION, 1);
      setProgress(pct);
      if (pct >= 1) {
        if (timerRef.current) clearInterval(timerRef.current);
        nextStory();
      }
    }, 30);
  }, []);

  const pauseTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    elapsedRef.current += Date.now() - startTimeRef.current;
    setIsPaused(true);
  }, []);

  const resumeTimer = useCallback(() => {
    setIsPaused(false);
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = elapsedRef.current + (Date.now() - startTimeRef.current);
      const pct = Math.min(elapsed / STORY_DURATION, 1);
      setProgress(pct);
      if (pct >= 1) {
        if (timerRef.current) clearInterval(timerRef.current);
        nextStory();
      }
    }, 30);
  }, []);

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Start timer when story changes
  useEffect(() => {
    if (selectedGroup) {
      setProgress(0);
      elapsedRef.current = 0;
      setShowViewers(false);
      startTimer();
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setProgress(0);
    }
  }, [selectedGroup, currentStoryIndex, startTimer]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setIsCreating(true);
    let uploadedPath: string | null = null;

    try {
      const { uploadToR2 } = await import('@/lib/r2');
      const normalizedFile = file;
      const { url, path } = await uploadToR2(normalizedFile, 'stories');
      uploadedPath = path;
      await createStory.mutateAsync({ imageUrl: url });
      toast({ title: 'Story publiée !' });
    } catch (error) {
      if (uploadedPath) {
        const { deleteFromR2 } = await import('@/lib/r2');
        await deleteFromR2(uploadedPath).catch(() => undefined);
      }

      const message = error instanceof Error ? error.message : 'Impossible de publier la story';
      toast({ title: 'Erreur', description: message, variant: 'destructive' });
    } finally {
      setIsCreating(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openStory = (group: GroupedStories, index = 0) => {
    setSelectedGroup(group);
    setCurrentStoryIndex(index);
    const story = group.stories[index];
    if (!story.is_viewed && story.user_id !== user?.id) {
      viewStory.mutate(story.id);
    }
  };

  const nextStory = useCallback(() => {
    setSelectedGroup(prev => {
      if (!prev) return null;

      const nextIndex = currentStoryIndex + 1;
      if (nextIndex < prev.stories.length) {
        setCurrentStoryIndex(nextIndex);
        const story = prev.stories[nextIndex];
        if (!story.is_viewed && story.user_id !== user?.id) {
          viewStory.mutate(story.id);
        }
        return prev;
      }

      // Move to next group
      const currentGroupIndex = groupedStories?.findIndex(g => g.user_id === prev.user_id) ?? -1;
      if (groupedStories && currentGroupIndex < groupedStories.length - 1) {
        const nextGroup = groupedStories[currentGroupIndex + 1];
        setCurrentStoryIndex(0);
        const story = nextGroup.stories[0];
        if (!story.is_viewed && story.user_id !== user?.id) {
          viewStory.mutate(story.id);
        }
        return nextGroup;
      }

      // End - close
      return null;
    });
  }, [currentStoryIndex, groupedStories, user?.id, viewStory]);

  const prevStory = () => {
    if (currentStoryIndex > 0) {
      setCurrentStoryIndex(currentStoryIndex - 1);
    } else if (selectedGroup) {
      const currentIndex = groupedStories?.findIndex(g => g.user_id === selectedGroup.user_id) ?? -1;
      if (groupedStories && currentIndex > 0) {
        const prevGroup = groupedStories[currentIndex - 1];
        setSelectedGroup(prevGroup);
        setCurrentStoryIndex(prevGroup.stories.length - 1);
      }
    }
  };

  const handleDelete = () => {
    if (!selectedGroup) return;
    const story = selectedGroup.stories[currentStoryIndex];
    if (confirm('Supprimer cette story ?')) {
      deleteStory.mutate(story.id);
      if (selectedGroup.stories.length === 1) {
        setSelectedGroup(null);
      } else {
        nextStory();
      }
    }
  };

  const handleLike = () => {
    if (!currentStory) return;
    likeStory.mutate({ storyId: currentStory.id, isLiked: currentStory.is_liked });
  };

  const toggleViewers = () => {
    const next = !showViewers;
    setShowViewers(next);
    if (next) pauseTimer();
    else resumeTimer();
  };

  const closeViewer = () => {
    setSelectedGroup(null);
    setCurrentStoryIndex(0);
    setShowViewers(false);
  };

  if (isLoading) {
    return (
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide px-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex-shrink-0 w-[110px] h-[190px] rounded-xl skeleton" />
        ))}
      </div>
    );
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,image/heic,image/heif,video/*,.heic,.heif,.mp4,.mov,.m4v,.webm"
        className="hidden"
        onChange={handleFileSelect}
      />
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide px-2">
        {/* Create Story Card */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => { if (!isCreating) fileInputRef.current?.click(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') fileInputRef.current?.click(); }}
          className="flex-shrink-0 w-[110px] h-[190px] rounded-xl overflow-hidden relative group bg-card border border-border/20 cursor-pointer"
        >
          {/* User photo top half */}
          <div className="h-[130px] w-full overflow-hidden bg-muted">
            {user && (
              <img 
                src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${user.id}`} 
                alt="" 
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
            )}
          </div>
          {/* Plus button */}
          <div className="absolute left-1/2 -translate-x-1/2 top-[118px] w-9 h-9 rounded-full bg-primary border-4 border-card flex items-center justify-center z-10">
            <Plus className={cn("w-5 h-5 text-primary-foreground", isCreating && "animate-spin")} />
          </div>
          {/* Bottom label */}
          <div className="h-[60px] flex items-end justify-center pb-2">
            <span className="text-[11px] font-semibold text-foreground text-center leading-tight">Créer une<br/>story</span>
          </div>
        </div>

        {/* Story Cards */}
        {groupedStories?.map((group) => (
          <button
            key={group.user_id}
            onClick={() => openStory(group)}
            className="flex-shrink-0 w-[110px] h-[190px] rounded-xl overflow-hidden relative group"
          >
            {/* Full cover photo */}
            <div className="absolute inset-0">
              {group.stories[0]?.image_url ? (
                <img 
                  src={group.stories[0].image_url} 
                  alt={group.profile.name} 
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full bg-muted" />
              )}
              {/* Gradient overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
            </div>
            {/* Unviewed ring avatar */}
            <div className="absolute top-2 left-2 z-10">
              <div className={cn(
                "p-[2px] rounded-full",
                group.has_unviewed ? "bg-primary" : "bg-border/60"
              )}>
                <div className="p-[1px] rounded-full bg-card">
                  <div className="w-9 h-9 rounded-full overflow-hidden">
                    {group.profile.avatar_url ? (
                      <img src={group.profile.avatar_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <UserAvatar src={null} alt={group.profile.name} size="sm" />
                    )}
                  </div>
                </div>
              </div>
            </div>
            {/* Name at bottom */}
            <div className="absolute bottom-0 left-0 right-0 p-2 z-10">
              <span className="text-white text-[11px] font-semibold drop-shadow-lg leading-tight line-clamp-2">
                {group.user_id === user?.id ? 'Ma story' : group.profile.name}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Story Viewer - Full Screen Overlay */}
      <AnimatePresence>
        {selectedGroup && currentStory && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[100] bg-black flex items-center justify-center"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeViewer();
            }}
          >
            <div
              className="relative w-full max-w-md h-full max-h-[100dvh] mx-auto"
              onPointerDown={() => { if (!showViewers) pauseTimer(); }}
              onPointerUp={() => { if (!showViewers) resumeTimer(); }}
            >
              {/* Progress bars */}
              <div className="absolute top-3 left-3 right-3 flex gap-1 z-20">
                {selectedGroup.stories.map((_, i) => (
                  <div key={i} className="h-[3px] flex-1 rounded-full bg-white/25 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-white transition-none"
                      style={{
                        width: i < currentStoryIndex
                          ? '100%'
                          : i === currentStoryIndex
                          ? `${progress * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                ))}
              </div>

              {/* Header */}
              <div className="absolute top-8 left-3 right-3 flex items-center justify-between z-20">
                <div className="flex items-center gap-2 backdrop-blur-md bg-black/30 rounded-xl px-2.5 py-1.5">
                  <UserAvatar 
                    src={currentStory.profile.avatar_url} 
                    alt={currentStory.profile.name}
                    size="sm"
                  />
                  <div>
                    <p className="text-white text-sm font-semibold">{currentStory.profile.name}</p>
                    <p className="text-white/50 text-[10px]">
                      {formatDistanceToNow(new Date(currentStory.created_at), { addSuffix: true, locale: fr })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {isOwner && (
                    <>
                      <button 
                        onClick={(e) => { e.stopPropagation(); toggleViewers(); }}
                        className="flex items-center gap-1 text-white/70 text-xs backdrop-blur-md bg-black/30 rounded-lg px-2 py-1 hover:bg-white/10 transition-colors"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        {currentStory.views_count}
                      </button>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={(e) => { e.stopPropagation(); handleDelete(); }}
                        className="h-8 w-8 text-white/70 hover:text-red-400 hover:bg-white/10 rounded-xl backdrop-blur-md"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </>
                  )}
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    onClick={(e) => { e.stopPropagation(); closeViewer(); }}
                    className="h-8 w-8 text-white hover:bg-white/20 rounded-xl backdrop-blur-md"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Story Image/Video */}
              <AnimatePresence mode="wait">
                {currentStory.image_url.match(/\.(mp4|webm|mov|ogg)(\?|$)/i) ? (
                  <motion.video
                    key={currentStory.id}
                    initial={{ scale: 1.05, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.98, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    src={currentStory.image_url}
                    className="w-full h-full object-cover"
                    autoPlay
                    muted
                    playsInline
                    loop
                  />
                ) : (
                  <motion.img
                    key={currentStory.id}
                    initial={{ scale: 1.05, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.98, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    src={currentStory.image_url}
                    alt="Story"
                    className="w-full h-full object-cover"
                  />
                )}
              </AnimatePresence>

              {/* Bottom bar: Like button + likes count */}
              {!isOwner && (
                <div className="absolute bottom-6 left-3 right-3 z-20 flex items-center justify-between">
                  {currentStory.caption ? (
                    <motion.div 
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex-1 text-white text-center text-sm bg-black/40 backdrop-blur-xl rounded-xl p-3 border border-white/10 mr-3"
                    >
                      {currentStory.caption}
                    </motion.div>
                  ) : <div className="flex-1" />}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleLike(); }}
                    className="flex flex-col items-center gap-0.5"
                  >
                    <Heart className={cn(
                      "w-7 h-7 transition-all",
                      currentStory.is_liked 
                        ? "text-red-500 fill-red-500 scale-110" 
                        : "text-white"
                    )} />
                    {currentStory.likes_count > 0 && (
                      <span className="text-white text-[10px] font-medium">{currentStory.likes_count}</span>
                    )}
                  </button>
                </div>
              )}

              {/* Owner: Caption without like */}
              {isOwner && currentStory.caption && !showViewers && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute bottom-6 left-3 right-3 z-20"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 text-white text-center text-sm bg-black/40 backdrop-blur-xl rounded-xl p-3 border border-white/10 mr-3">
                      {currentStory.caption}
                    </div>
                    {currentStory.likes_count > 0 && (
                      <div className="flex items-center gap-1 text-white/70 text-xs backdrop-blur-md bg-black/30 rounded-lg px-2 py-1">
                        <Heart className="w-3.5 h-3.5 text-red-400 fill-red-400" />
                        {currentStory.likes_count}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}

              {/* Owner: Likes count when no caption */}
              {isOwner && !currentStory.caption && !showViewers && currentStory.likes_count > 0 && (
                <div className="absolute bottom-6 right-3 z-20 flex items-center gap-1 text-white/70 text-xs backdrop-blur-md bg-black/30 rounded-lg px-2 py-1">
                  <Heart className="w-3.5 h-3.5 text-red-400 fill-red-400" />
                  {currentStory.likes_count}
                </div>
              )}

              {/* Viewers panel (owner only) */}
              <AnimatePresence>
                {showViewers && isOwner && (
                  <motion.div
                    initial={{ y: '100%' }}
                    animate={{ y: 0 }}
                    exit={{ y: '100%' }}
                    transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    className="absolute bottom-0 left-0 right-0 z-30 bg-background/95 backdrop-blur-xl rounded-t-2xl border-t border-border/30 max-h-[60%] overflow-y-auto"
                    onClick={e => e.stopPropagation()}
                    onPointerDown={e => e.stopPropagation()}
                  >
                    <div className="sticky top-0 bg-background/95 backdrop-blur-xl px-4 py-3 border-b border-border/20 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Eye className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm font-semibold">{currentStory.views_count} vue{currentStory.views_count > 1 ? 's' : ''}</span>
                        {currentStory.likes_count > 0 && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1 ml-2">
                            <Heart className="w-3 h-3 text-red-400 fill-red-400" /> {currentStory.likes_count}
                          </span>
                        )}
                      </div>
                      <button onClick={toggleViewers} className="text-muted-foreground hover:text-foreground p-1">
                        <ChevronUp className="w-4 h-4 rotate-180" />
                      </button>
                    </div>
                    <div className="p-2">
                      {!viewers || viewers.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">Aucune vue pour le moment</p>
                      ) : (
                        viewers.map(v => (
                          <Link
                            key={v.viewer_id}
                            to={`/profile/${v.viewer_id}`}
                            onClick={closeViewer}
                            className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-secondary/50 transition-colors"
                          >
                            <UserAvatar src={v.avatar_url} alt={v.name} size="sm" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{v.name}</p>
                              <p className="text-[10px] text-muted-foreground">
                                {formatDistanceToNow(new Date(v.viewed_at), { addSuffix: true, locale: fr })}
                              </p>
                            </div>
                          </Link>
                        ))
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Navigation touch zones */}
              {!showViewers && (
                <>
                  <button 
                    onClick={prevStory} 
                    className="absolute left-0 top-16 bottom-16 w-1/3 z-10 focus:outline-none" 
                    aria-label="Story précédente"
                  />
                  <button 
                    onClick={nextStory} 
                    className="absolute right-0 top-16 bottom-16 w-1/3 z-10 focus:outline-none" 
                    aria-label="Story suivante"
                  />
                </>
              )}

              {/* Paused indicator */}
              {isPaused && !showViewers && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none">
                  <div className="w-12 h-12 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
                    <div className="flex gap-1">
                      <div className="w-1.5 h-5 bg-white rounded-full" />
                      <div className="w-1.5 h-5 bg-white rounded-full" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}