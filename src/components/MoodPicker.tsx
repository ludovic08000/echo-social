import { useState } from 'react';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Smile, X } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

const MOOD_EMOJIS = [
  { emoji: '😊', label: 'Content' },
  { emoji: '😴', label: 'Fatigué' },
  { emoji: '😎', label: 'Cool' },
  { emoji: '🤔', label: 'Pensif' },
  { emoji: '😍', label: 'Amoureux' },
  { emoji: '🎉', label: 'Fête' },
  { emoji: '📚', label: 'Studieux' },
  { emoji: '💪', label: 'Motivé' },
  { emoji: '🎮', label: 'Gaming' },
  { emoji: '🎵', label: 'Musical' },
  { emoji: '☕', label: 'Détente' },
  { emoji: '🔥', label: 'En feu' },
  { emoji: '😤', label: 'Frustré' },
  { emoji: '🌧️', label: 'Mélancolique' },
  { emoji: '✈️', label: 'Voyage' },
  { emoji: '🍕', label: 'Gourmand' },
];

export function MoodPicker() {
  const { data: profile } = useProfile();
  const updateProfile = useUpdateProfile();
  const [open, setOpen] = useState(false);
  const [moodText, setMoodText] = useState('');
  const [selectedEmoji, setSelectedEmoji] = useState<string | null>(null);

  const handleSetMood = async (emoji: string) => {
    setSelectedEmoji(emoji);
  };

  const handleConfirm = async () => {
    if (!selectedEmoji) return;
    try {
      await updateProfile.mutateAsync({
        mood_emoji: selectedEmoji,
        mood_text: moodText.trim() || null,
      } as any);
      toast({ title: `${selectedEmoji} Humeur mise à jour !` });
      setOpen(false);
      setMoodText('');
      setSelectedEmoji(null);
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const handleClearMood = async () => {
    try {
      await updateProfile.mutateAsync({
        mood_emoji: null,
        mood_text: null,
      } as any);
      toast({ title: 'Humeur retirée' });
      setOpen(false);
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const currentMood = (profile as any)?.mood_emoji;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary/60 hover:bg-secondary text-xs text-muted-foreground transition-all hover:text-foreground">
          {currentMood ? (
            <span className="text-sm">{currentMood}</span>
          ) : (
            <Smile className="w-3.5 h-3.5" />
          )}
          <span>{currentMood ? (profile as any)?.mood_text || 'Mon humeur' : 'Définir mon humeur'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3 rounded-2xl">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">Comment tu te sens ?</h4>
            {currentMood && (
              <Button variant="ghost" size="sm" onClick={handleClearMood} className="h-7 text-xs text-muted-foreground">
                <X className="w-3 h-3 mr-1" />
                Retirer
              </Button>
            )}
          </div>
          
          <div className="grid grid-cols-4 gap-1.5">
            {MOOD_EMOJIS.map(({ emoji, label }) => (
              <button
                key={emoji}
                onClick={() => handleSetMood(emoji)}
                className={`flex flex-col items-center gap-0.5 p-2 rounded-xl transition-all text-center ${
                  selectedEmoji === emoji 
                    ? 'bg-primary/15 ring-2 ring-primary/30 scale-105' 
                    : 'hover:bg-secondary/60'
                }`}
                title={label}
              >
                <span className="text-xl">{emoji}</span>
                <span className="text-[9px] text-muted-foreground leading-tight">{label}</span>
              </button>
            ))}
          </div>

          {selectedEmoji && (
            <div className="space-y-2 animate-fade-in">
              <Input
                placeholder="Ajouter un message..."
                value={moodText}
                onChange={(e) => setMoodText(e.target.value)}
                maxLength={50}
                className="h-8 text-xs rounded-xl"
              />
              <Button onClick={handleConfirm} size="sm" className="w-full h-8 text-xs rounded-xl">
                {selectedEmoji} Valider
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
