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
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed bottom-0 left-0 right-0 z-[9999] p-4 md:p-6"
        >
          <div className="max-w-2xl mx-auto bg-card border border-border rounded-2xl shadow-2xl p-5 md:p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <Cookie className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold text-foreground text-base">Cookies & Confidentialité</h3>
                <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                  Forsure utilise uniquement des <strong>cookies techniques</strong> essentiels au fonctionnement du site 
                  (authentification, préférences). <strong>Aucun cookie publicitaire</strong> ni de traçage n'est utilisé. 
                  Vos cookies sont protégés par les attributs <strong>Secure, HttpOnly, SameSite=Strict</strong>.
                </p>
                <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                  <Shield className="w-3.5 h-3.5 text-green-500" />
                  <span>Conforme RGPD · CNIL · ePrivacy</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
              <Button
                onClick={acceptCookies}
                className="flex-1 sm:flex-none"
                size="sm"
              >
                Accepter
              </Button>
              <Button
                onClick={declineCookies}
                variant="outline"
                className="flex-1 sm:flex-none"
                size="sm"
              >
                Refuser
              </Button>
              <Link
                to="/privacy"
                className="text-xs text-muted-foreground hover:text-primary underline text-center sm:ml-auto"
              >
                Politique de confidentialité
              </Link>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
