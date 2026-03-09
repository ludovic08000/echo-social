import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { motion } from 'framer-motion';

const INTERESTS = [
  { value: 'gaming', label: 'Gaming', emoji: '🎮', color: 'border-purple-500/40 bg-purple-500/10 text-purple-300' },
  { value: 'music', label: 'Musique', emoji: '🎵', color: 'border-pink-500/40 bg-pink-500/10 text-pink-300' },
  { value: 'sport', label: 'Sport', emoji: '⚽', color: 'border-green-500/40 bg-green-500/10 text-green-300' },
  { value: 'news', label: 'Actualités', emoji: '📰', color: 'border-blue-500/40 bg-blue-500/10 text-blue-300' },
  { value: 'education', label: 'Éducation', emoji: '📚', color: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300' },
  { value: 'cooking', label: 'Cuisine', emoji: '🍳', color: 'border-orange-500/40 bg-orange-500/10 text-orange-300' },
  { value: 'tech', label: 'Tech', emoji: '💻', color: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300' },
  { value: 'art', label: 'Art & Créativité', emoji: '🎨', color: 'border-rose-500/40 bg-rose-500/10 text-rose-300' },
  { value: 'lifestyle', label: 'Lifestyle', emoji: '✨', color: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
  { value: 'comedy', label: 'Humour', emoji: '😂', color: 'border-lime-500/40 bg-lime-500/10 text-lime-300' },
  { value: 'travel', label: 'Voyage', emoji: '✈️', color: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
];

const MIN_INTERESTS = 3;

export default function Onboarding() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [selected, setSelected] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const toggle = (value: string) => {
    setSelected(prev =>
      prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]
    );
  };

  const handleContinue = async () => {
    if (selected.length < MIN_INTERESTS) {
      toast({ title: `Choisis au moins ${MIN_INTERESTS} centres d'intérêt`, variant: 'destructive' });
      return;
    }
    if (!user) return;

    setIsSubmitting(true);
    try {
      const rows = selected.map(interest => ({
        user_id: user.id,
        interest_type: 'category',
        interest_value: interest,
        explicit: true,
        weight: 1,
      }));

      const { error } = await supabase.from('user_interests').upsert(rows, { onConflict: 'user_id,interest_type,interest_value' } as any);
      if (error) throw error;

      toast({ title: 'Bienvenue sur ForSure ! 🎉' });
      navigate('/feed', { replace: true });
    } catch (err: any) {
      toast({ title: 'Erreur', description: err.message, variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg">
        <div className="flex items-center justify-center mb-6">
          <BrandLogo className="h-10 w-auto" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="pulse-card p-6 sm:p-8"
        >
          <div className="text-center mb-6">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-3 py-1 rounded-full text-sm font-medium mb-3">
              <Sparkles className="w-4 h-4" />
              Personnalise ton expérience
            </div>
            <h1 className="text-2xl font-bold text-foreground">Qu'est-ce qui t'intéresse ?</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Choisis au moins {MIN_INTERESTS} sujets pour personnaliser ton fil d'actualité
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
            {INTERESTS.map((item) => {
              const isSelected = selected.includes(item.value);
              return (
                <motion.button
                  key={item.value}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => toggle(item.value)}
                  className={`
                    relative flex flex-col items-center gap-1.5 p-4 rounded-xl border-2 transition-all duration-200
                    ${isSelected
                      ? 'border-primary bg-primary/10 shadow-lg shadow-primary/10'
                      : `${item.color} hover:border-primary/30`
                    }
                  `}
                >
                  {isSelected && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="absolute top-1.5 right-1.5 bg-primary rounded-full p-0.5"
                    >
                      <Check className="w-3 h-3 text-primary-foreground" />
                    </motion.div>
                  )}
                  <span className="text-2xl">{item.emoji}</span>
                  <span className={`text-sm font-medium ${isSelected ? 'text-primary' : ''}`}>
                    {item.label}
                  </span>
                </motion.button>
              );
            })}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {selected.length}/{MIN_INTERESTS} minimum
            </span>
            <Button
              onClick={handleContinue}
              disabled={selected.length < MIN_INTERESTS || isSubmitting}
              className="pulse-button-gradient px-8"
            >
              {isSubmitting ? 'Enregistrement…' : 'Continuer'}
            </Button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
