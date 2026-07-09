import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, MessageCircle, Users, Video, Sparkles, Bell, ShoppingBag, Gamepad2, ChevronRight, Shield, Heart, Palette, BookOpen, Trophy, Brain, Radio, Search, Baby, Image } from 'lucide-react';
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
    title: 'Messagerie chiffrée 🔒',
    description: 'Tes messages sont protégés par un chiffrement de bout en bout. Notes vocales, GIFs, transfert de messages et traduction IA inclus.',
    position: 'bottom',
  },
  {
    icon: <Users className="w-5 h-5" />,
    title: 'Amis & Groupes 👥',
    description: 'Ajoute des amis, crée des groupes et des pages. Organise tes proches en cercles personnalisés et découvre des profils par ville.',
    position: 'bottom',
  },
  {
    icon: <Video className="w-5 h-5" />,
    title: 'Lives & Appels vidéo 🎥',
    description: 'Lance un live avec chat en direct, ou passe des appels audio/vidéo chiffrés avec tes contacts.',
    position: 'bottom',
  },
  {
    icon: <Sparkles className="w-5 h-5" />,
    title: 'Zeus — ton IA personnelle ✨',
    description: 'Assistant IA intégré partout : rédige tes posts, traduis, gère ton algorithme de feed, et exécute des actions pour toi.',
    position: 'bottom',
  },
  {
    icon: <Image className="w-5 h-5" />,
    title: 'Publications & Stories 📸',
    description: 'Publie textes, photos et vidéos. Ajoute des stories éphémères, des capsules temporelles, et améliore tes textes avec l\'IA.',
    position: 'bottom',
  },
  {
    icon: <Brain className="w-5 h-5" />,
    title: 'Feed intelligent 🧠',
    description: 'Choisis ton algorithme : intelligent, chronologique ou amis d\'abord. Ajuste les poids et filtre le contenu viral.',
    position: 'bottom',
  },
  {
    icon: <ShoppingBag className="w-5 h-5" />,
    title: 'Marketplace 🛍️',
    description: 'Achète et vends en Europe avec négociation intégrée, livraison Mondial Relay et paiement sécurisé Stripe.',
    position: 'bottom',
  },
  {
    icon: <Bell className="w-5 h-5" />,
    title: 'Notifications en temps réel 🔔',
    description: 'Likes, commentaires, demandes d\'amis, messages — tout en temps réel avec sons personnalisables.',
    position: 'top',
  },
  {
    icon: <Shield className="w-5 h-5" />,
    title: 'Sécurité & Confidentialité 🛡️',
    description: 'Vérification d\'identité, signalement, modération IA, chiffrement E2E et contrôle total de ta vie privée.',
    position: 'bottom',
  },
  {
    icon: <Baby className="w-5 h-5" />,
    title: 'Protection des mineurs 👶',
    description: 'Contrôle parental avec code PIN, filtrage de contenu, profil privé forcé et blocage des messages d\'inconnus.',
    position: 'bottom',
  },
  {
    icon: <Heart className="w-5 h-5" />,
    title: 'Bien-être numérique 💚',
    description: 'Pause scroll, limite de temps quotidienne, journal intime, détox programmée et mode niveaux de gris.',
    position: 'bottom',
  },
  {
    icon: <Palette className="w-5 h-5" />,
    title: 'Personnalisation totale 🎨',
    description: 'Mode Focus ou Glow, thème clair/sombre, fonds d\'écran, couleurs du feed et accessibilité avancée.',
    position: 'bottom',
  },
  {
    icon: <Search className="w-5 h-5" />,
    title: 'Recherche & Découverte 🔍',
    description: 'Recherche universelle de personnes, posts, groupes et produits. Suggestions d\'amis par ville et centres d\'intérêt.',
    position: 'bottom',
  },
  {
    icon: <Radio className="w-5 h-5" />,
    title: 'Agents IA spécialisés 🤖',
    description: 'Coach mental, assistant bien-être, analyse émotionnelle et recommandations personnalisées. 10 messages/jour gratuits.',
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
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9998] bg-black/40"
            onClick={dismiss}
          />

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
              <button
                onClick={dismiss}
                className="absolute top-3 right-3 w-7 h-7 rounded-full bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>

              <div className="flex items-start gap-3.5">
                <div className="w-11 h-11 rounded-2xl bg-primary/15 flex items-center justify-center text-primary shrink-0">
                  {step.icon}
                </div>
                <div className="flex-1 min-w-0 pr-4">
                  <h3 className="font-semibold text-[15px] text-foreground mb-1">{step.title}</h3>
                  <p className="text-[13px] text-muted-foreground leading-relaxed">{step.description}</p>
                </div>
              </div>

              <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/30">
                <div className="flex gap-1 items-center">
                  {STEPS.map((_, i) => (
                    <div
                      key={i}
                      className={cn(
                        'h-1.5 rounded-full transition-all duration-300',
                        i === currentStep ? 'w-4 bg-primary' : i < currentStep ? 'w-1.5 bg-primary/40' : 'w-1.5 bg-muted-foreground/20'
                      )}
                    />
                  ))}
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-muted-foreground">{currentStep + 1}/{STEPS.length}</span>
                  <button
                    onClick={next}
                    className="flex items-center gap-1 text-[13px] font-semibold text-primary hover:text-primary/80 transition-colors"
                  >
                    {isLast ? 'C\'est parti !' : 'Suivant'}
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

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
