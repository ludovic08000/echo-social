import { useCookieConsent } from '@/hooks/useCookieConsent';
import { Button } from '@/components/ui/button';
import { Shield, Cookie } from 'lucide-react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';

export function CookieConsentBanner() {
  const { showBanner, acceptCookies, declineCookies } = useCookieConsent();

  return (
    <AnimatePresence>
      {showBanner && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          className="fixed bottom-0 left-0 right-0 z-[9999] px-3 pb-[env(safe-area-inset-bottom,12px)] pt-2"
        >
          <div className="max-w-lg mx-auto bg-card/95 backdrop-blur-xl border border-border/60 rounded-2xl shadow-xl p-4">
            <div className="flex items-center gap-2.5 mb-2.5">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Cookie className="w-4 h-4 text-primary" />
              </div>
              <h3 className="font-semibold text-foreground text-sm">Cookies & Confidentialité</h3>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed mb-3">
              Forsure utilise uniquement des <strong>cookies techniques</strong> essentiels.{' '}
              <strong>Aucun traçage publicitaire.</strong>{' '}
              <span className="inline-flex items-center gap-1">
                <Shield className="w-3 h-3 text-green-500 inline" />
                Conforme RGPD · CNIL
              </span>
            </p>

            <div className="flex items-center gap-2">
              <Button onClick={acceptCookies} size="sm" className="flex-1 h-9 text-xs font-semibold rounded-xl">
                Accepter
              </Button>
              <Button onClick={declineCookies} variant="outline" size="sm" className="flex-1 h-9 text-xs rounded-xl">
                Refuser
              </Button>
              <Link
                to="/privacy"
                className="text-[10px] text-muted-foreground hover:text-primary underline shrink-0 px-1"
              >
                En savoir +
              </Link>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
