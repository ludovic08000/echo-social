import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X, Eye } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { useStories, useCreateStory, useViewStory, useDeleteStory, GroupedStories } from '@/hooks/useStories';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from './UserAvatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';

export function StoriesBar() {
  const { data: groupedStories, isLoading } = useStories();
  const { user } = useAuth();
  const [selectedGroup, setSelectedGroup] = useState<GroupedStories | null>(null);
  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createStory = useCreateStory();
  const viewStory = useViewStory();
  const deleteStory = useDeleteStory();

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setIsCreating(true);
    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${user.id}/${Date.now()}.${fileExt}`;
      
      const { error: uploadError } = await supabase.storage
        .from('post-images')
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('post-images')
        .getPublicUrl(fileName);

      await createStory.mutateAsync({ imageUrl: publicUrl });
      toast({ title: 'Story publiée !' });
    } catch (error) {
      toast({ title: 'Erreur', description: 'Impossible de publier la story', variant: 'destructive' });
    } finally {
      setIsCreating(false);
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

  const nextStory = () => {
    if (!selectedGroup) return;
    if (currentStoryIndex < selectedGroup.stories.length - 1) {
      const nextIndex = currentStoryIndex + 1;
      setCurrentStoryIndex(nextIndex);
      const story = selectedGroup.stories[nextIndex];
      if (!story.is_viewed && story.user_id !== user?.id) {
        viewStory.mutate(story.id);
      }
    } else {
      const currentIndex = groupedStories?.findIndex(g => g.user_id === selectedGroup.user_id) ?? -1;
      if (groupedStories && currentIndex < groupedStories.length - 1) {
        const nextGroup = groupedStories[currentIndex + 1];
        setSelectedGroup(nextGroup);
        setCurrentStoryIndex(0);
        const story = nextGroup.stories[0];
        if (!story.is_viewed && story.user_id !== user?.id) {
          viewStory.mutate(story.id);
        }
      } else {
        setSelectedGroup(null);
      }
    }
  };

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

  const currentStory = selectedGroup?.stories[currentStoryIndex];
  const isOwner = currentStory?.user_id === user?.id;

  if (isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
        {[1, 2, 3, 4].map((i) => (
          <motion.div 
            key={i} 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.08 }}
            className="flex-shrink-0 w-[72px]"
          >
            <div className="w-[72px] h-[72px] rounded-2xl skeleton" />
          </motion.div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
        {/* Add Story Button */}
        <motion.div 
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex-shrink-0 flex flex-col items-center gap-1"
        >
          <motion.button
            whileHover={{ scale: 1.08, y: -2 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => fileInputRef.current?.click()}
            disabled={isCreating}
            className="relative w-[68px] h-[68px] rounded-2xl bg-secondary/40 border border-dashed border-primary/30 flex items-center justify-center transition-all duration-300 hover:bg-primary/5 hover:border-primary/50 hover:shadow-[0_4px_16px_hsl(220_70%_50%/0.12)] group"
          >
            <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
              <Plus className={cn("w-5 h-5 text-primary", isCreating && "animate-spin")} />
            </div>
          </motion.button>
          <span className="text-[10px] text-muted-foreground font-medium">Story</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileSelect}
          />
        </motion.div>

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

      {/* Story Viewer Modal */}
      <Dialog open={!!selectedGroup} onOpenChange={() => setSelectedGroup(null)}>
        <DialogContent className="max-w-lg p-0 bg-black border-none overflow-hidden rounded-2xl">
          {currentStory && (
            <div className="relative aspect-[9/16] max-h-[80vh]">
              {/* Progress bars */}
              <div className="absolute top-3 left-3 right-3 flex gap-1 z-10">
                {selectedGroup?.stories.map((_, i) => (
                  <div 
                    key={i}
                    className={cn(
                      "h-[3px] flex-1 rounded-full transition-all duration-300",
                      i < currentStoryIndex ? "bg-white" : 
                      i === currentStoryIndex ? "bg-white/90 shadow-[0_0_6px_rgba(255,255,255,0.5)]" : "bg-white/25"
                    )}
                  />
                ))}
              </div>

              {/* Header */}
              <div className="absolute top-8 left-3 right-3 flex items-center justify-between z-10">
                <div className="flex items-center gap-2 backdrop-blur-sm bg-black/20 rounded-xl px-2 py-1.5">
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
                <div className="flex items-center gap-2">
                  {isOwner && (
                    <>
                      <div className="flex items-center gap-1 text-white/70 text-xs backdrop-blur-sm bg-black/20 rounded-lg px-2 py-1">
                        <Eye className="w-3.5 h-3.5" />
                        {currentStory.views_count}
                      </div>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={handleDelete}
                        className="h-8 w-8 text-white hover:bg-white/20 rounded-xl backdrop-blur-sm"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Image */}
              <motion.img
                initial={{ scale: 1.05, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.4 }}
                src={currentStory.image_url}
                alt="Story"
                className="w-full h-full object-cover"
              />

              {/* Caption */}
              {currentStory.caption && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute bottom-4 left-3 right-3 text-white text-center text-sm bg-black/40 backdrop-blur-xl rounded-xl p-3 border border-white/10"
                >
                  {currentStory.caption}
                </motion.div>
              )}

              {/* Navigation */}
              <button onClick={prevStory} className="absolute left-0 top-0 bottom-0 w-1/3 z-10" />
              <button onClick={nextStory} className="absolute right-0 top-0 bottom-0 w-1/3 z-10" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
