import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X, Eye, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { useStories, useCreateStory, useViewStory, useDeleteStory, GroupedStories } from '@/hooks/useStories';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';

const STORY_DURATION = 5000; // 5 seconds per story

export function StoriesBar() {
  const { data: groupedStories, isLoading } = useStories();
  const { user } = useAuth();
  const [selectedGroup, setSelectedGroup] = useState<GroupedStories | null>(null);
  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);
  const createStory = useCreateStory();
  const viewStory = useViewStory();
  const deleteStory = useDeleteStory();

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
    try {
      const { uploadToR2 } = await import('@/lib/r2');
      const { url } = await uploadToR2(file, 'stories');
      await createStory.mutateAsync({ imageUrl: url });
      toast({ title: 'Story publiée !' });
    } catch (error) {
      toast({ title: 'Erreur', description: 'Impossible de publier la story', variant: 'destructive' });
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

  const closeViewer = () => {
    setSelectedGroup(null);
    setCurrentStoryIndex(0);
  };

  const currentStory = selectedGroup?.stories[currentStoryIndex];
  const isOwner = currentStory?.user_id === user?.id;

  if (isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex-shrink-0 w-[72px]">
            <div className="w-[72px] h-[72px] rounded-2xl skeleton" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
        {/* Add Story Button */}
        <div className="flex-shrink-0 flex flex-col items-center gap-1">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isCreating}
            className="relative w-[68px] h-[68px] rounded-2xl bg-secondary/40 border border-dashed border-primary/30 flex items-center justify-center transition-all duration-300 hover:bg-primary/5 hover:border-primary/50 group"
          >
            <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
              <Plus className={cn("w-5 h-5 text-primary", isCreating && "animate-spin")} />
            </div>
          </button>
          <span className="text-[10px] text-muted-foreground font-medium">Story</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v"
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>

        {/* Stories */}
        {groupedStories?.map((group, i) => (
          <motion.button
            key={group.user_id}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: (i + 1) * 0.05 }}
            whileHover={{ scale: 1.06, y: -2 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => openStory(group)}
            className="flex-shrink-0 flex flex-col items-center gap-1"
          >
            <div className={cn(
              "p-[2px] rounded-2xl transition-all duration-300",
              group.has_unviewed 
                ? "bg-[image:var(--premium-gradient)] shadow-[0_2px_12px_hsl(220_70%_50%/0.25)]" 
                : "bg-border/60"
            )}>
              <div className="p-[2px] rounded-[14px] bg-background">
                <div className="w-[60px] h-[60px] rounded-xl overflow-hidden">
                  {group.profile.avatar_url ? (
                    <img src={group.profile.avatar_url} alt={group.profile.name} className="w-full h-full object-cover transition-transform duration-300 hover:scale-110" />
                  ) : (
                    <UserAvatar src={null} alt={group.profile.name} size="lg" />
                  )}
                </div>
              </div>
            </div>
            <span className="text-[10px] text-muted-foreground truncate w-[68px] text-center font-medium">
              {group.user_id === user?.id ? 'Ma story' : group.profile.name.split(' ')[0]}
            </span>
          </motion.button>
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
              onPointerDown={() => pauseTimer()}
              onPointerUp={() => resumeTimer()}
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
                      <div className="flex items-center gap-1 text-white/70 text-xs backdrop-blur-md bg-black/30 rounded-lg px-2 py-1">
                        <Eye className="w-3.5 h-3.5" />
                        {currentStory.views_count}
                      </div>
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

              {/* Caption */}
              {currentStory.caption && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute bottom-6 left-3 right-3 text-white text-center text-sm bg-black/40 backdrop-blur-xl rounded-xl p-3 border border-white/10 z-20"
                >
                  {currentStory.caption}
                </motion.div>
              )}

              {/* Navigation touch zones */}
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

              {/* Paused indicator */}
              {isPaused && (
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
