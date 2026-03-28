import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, MessageCircle, Users, Video, Sparkles, Bell, ShoppingBag, Gamepad2, ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface BubbleStep {
  icon: React.ReactNode;
  title: string;
  description: string;
  position: 'top' | 'bottom';
}

const STEPS: BubbleStep[] = [
  {
    icon: <MessageCircle className="w-5 h-5" />,
    title: 'Messages privés 💬',
    description: 'Envoie des messages chiffrés à tes amis. Personne ne peut les lire, même pas nous !',
    position: 'bottom',
  },
  {
    icon: <Users className="w-5 h-5" />,
    title: 'Trouve tes amis 👋',
    description: 'Ajoute des amis, crée des groupes et retrouve ta communauté.',
    position: 'bottom',
  },
  {
    icon: <Video className="w-5 h-5" />,
    title: 'Lives en direct 🎥',
    description: 'Lance un live ou regarde ceux de tes amis en temps réel.',
    position: 'bottom',
  },
  {
    icon: <Sparkles className="w-5 h-5" />,
    title: 'Zeus, ton assistant IA ✨',
    description: 'Pose-lui des questions, traduis des messages ou demande de l\'aide. Il est là pour toi !',
    position: 'bottom',
  },
  {
    icon: <Bell className="w-5 h-5" />,
    title: 'Notifications 🔔',
    description: 'Reste au courant de tout : likes, commentaires, nouveaux amis…',
    position: 'top',
  },
  {
    icon: <ShoppingBag className="w-5 h-5" />,
    title: 'Marketplace 🛍️',
    description: 'Achète et vends des articles directement sur la plateforme.',
    position: 'bottom',
  },
  {
    icon: <Gamepad2 className="w-5 h-5" />,
    title: 'Jeux & Défis 🎮',
    description: 'Amuse-toi avec des mini-jeux et relève des défis avec tes amis !',
    position: 'bottom',
  },
];

const STORAGE_KEY = 'forsure-onboarding-seen';

export function OnboardingBubbles() {
  const { user } = useAuth();
  const [currentStep, setCurrentStep] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!user) return;
    const seen = localStorage.getItem(STORAGE_KEY);
    if (seen) return;
    // Show after a short delay to let the feed load
    const t = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(t);
  }, [user]);

  const dismiss = () => {
    setVisible(false);
    localStorage.setItem(STORAGE_KEY, 'true');
  };

  const next = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(s => s + 1);
    } else {
      dismiss();
    }
  };

  if (!visible || !user) return null;

  const step = STEPS[currentStep];
  const isLast = currentStep === STEPS.length - 1;

  return (
    <AnimatePresence>
      {visible && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9998] bg-black/40"
            onClick={dismiss}
          />

          {/* Bubble */}
          <motion.div
            key={currentStep}
            initial={{ opacity: 0, y: step.position === 'bottom' ? 40 : -40, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: step.position === 'bottom' ? 40 : -40, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className={cn(
              'fixed left-4 right-4 z-[9999] max-w-sm mx-auto',
              step.position === 'bottom' ? 'bottom-28' : 'top-20'
            )}
          >
            <div className="relative rounded-3xl p-5 bg-card border border-border/50 shadow-xl"
                 style={{ boxShadow: '0 8px 40px hsl(320 55% 50% / 0.15), 0 0 0 1px hsl(320 55% 50% / 0.08)' }}>
              {/* Close */}
              <button
                onClick={dismiss}
                className="absolute top-3 right-3 w-7 h-7 rounded-full bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>

              {/* Content */}
              <div className="flex items-start gap-3.5">
                <div className="w-11 h-11 rounded-2xl bg-primary/15 flex items-center justify-center text-primary shrink-0">
                  {step.icon}
                </div>
                <div className="flex-1 min-w-0 pr-4">
                  <h3 className="font-semibold text-[15px] text-foreground mb-1">{step.title}</h3>
                  <p className="text-[13px] text-muted-foreground leading-relaxed">{step.description}</p>
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/30">
                {/* Progress dots */}
                <div className="flex gap-1.5">
                  {STEPS.map((_, i) => (
                    <div
                      key={i}
                      className={cn(
                        'h-1.5 rounded-full transition-all duration-300',
                        i === currentStep ? 'w-5 bg-primary' : i < currentStep ? 'w-1.5 bg-primary/40' : 'w-1.5 bg-muted-foreground/20'
                      )}
                    />
                  ))}
                </div>

                {/* Next button */}
                <button
                  onClick={next}
                  className="flex items-center gap-1 text-[13px] font-semibold text-primary hover:text-primary/80 transition-colors"
                >
                  {isLast ? 'C\'est parti !' : 'Suivant'}
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Speech bubble triangle */}
              <div className={cn(
                'absolute left-1/2 -translate-x-1/2 w-4 h-4 bg-card border-border/50 rotate-45',
                step.position === 'bottom' ? '-bottom-2 border-b border-r' : '-top-2 border-t border-l'
              )} />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
