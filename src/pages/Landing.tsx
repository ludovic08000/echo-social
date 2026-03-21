import { Link } from 'react-router-dom';
import { Sparkles, Shield, MessageCircle, Video, Store, Tv, Users, Zap, Lock, Heart, Globe, ChevronDown } from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import Feed from './Feed';
import loginBg from '@/assets/login-bg.png';
import { useState } from 'react';

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border/50 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 sm:p-5 text-left hover:bg-muted/30 transition-colors"
      >
        <span className="font-semibold text-foreground pr-4">{question}</span>
        <ChevronDown className={`w-5 h-5 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 text-muted-foreground leading-relaxed">
          {answer}
        </div>
      )}
    </div>
  );
}

const features = [
  { icon: MessageCircle, title: 'Messagerie privée', desc: 'Échangez en toute confidentialité avec vos proches. Messages texte, vocaux, GIFs et appels vidéo intégrés.' },
  { icon: Video, title: 'Live streaming gratuit', desc: 'Lancez un live en un clic, interagissez avec votre audience en temps réel. Aucun abonnement requis.' },
  { icon: Tv, title: 'Canaux TV personnalisés', desc: 'Créez votre propre chaîne, publiez du contenu vidéo et construisez votre communauté de fans.' },
  { icon: Store, title: 'Marketplace intégré', desc: 'Vendez et achetez directement sur la plateforme. Paiement sécurisé et suivi de livraison inclus.' },
  { icon: Shield, title: 'Vie privée respectée', desc: 'Zéro cookie de tracking, zéro publicité ciblée. Vos données personnelles ne sont jamais vendues.' },
  { icon: Users, title: 'Communauté bienveillante', desc: 'Modération IA avancée, protection des mineurs et outils anti-harcèlement intégrés.' },
];

const advantages = [
  { icon: Lock, title: 'Sans publicité ni tracking', desc: 'Contrairement à Facebook et Instagram, Forsure ne monétise pas vos données. Profitez d\'une expérience 100% sans pub.' },
  { icon: Heart, title: 'Éthique par design', desc: 'Pas d\'algorithme addictif. Forsure privilégie votre bien-être numérique avec des outils de détox et de contrôle du temps d\'écran.' },
  { icon: Zap, title: 'Tout-en-un', desc: 'Messagerie, live, vidéos, marketplace, jeux, challenges... Tout ce dont vous avez besoin, dans une seule application.' },
  { icon: Globe, title: '100% français', desc: 'Conçu et hébergé en France, Forsure respecte le RGPD et les réglementations européennes sur la protection des données.' },
];

const faqItems = [
  { q: 'Forsure est-il gratuit ?', a: 'Oui, Forsure est entièrement gratuit. L\'inscription, la messagerie, le live streaming et toutes les fonctionnalités de base sont accessibles sans frais. Des options premium optionnelles sont disponibles pour les créateurs de contenu.' },
  { q: 'En quoi Forsure est différent de Facebook ou Instagram ?', a: 'Forsure est un réseau social éthique sans publicité ni tracking. Contrairement à Facebook et Instagram, vos données ne sont pas vendues à des annonceurs. Votre vie privée est respectée par design. De plus, Forsure intègre des fonctionnalités uniques comme les canaux TV, un marketplace et des jeux multijoueurs.' },
  { q: 'Forsure est-il disponible sur mobile ?', a: 'Oui, Forsure est accessible sur tous les navigateurs mobiles et est optimisé comme une application web progressive (PWA). Des applications iOS et Android natives sont également disponibles pour une expérience optimale.' },
  { q: 'Comment Forsure protège ma vie privée ?', a: 'Forsure n\'utilise aucun cookie de tracking, ne vend aucune donnée personnelle et ne diffuse aucune publicité ciblée. Les messages sont privés, les données restent sous votre contrôle et vous pouvez exporter ou supprimer vos données à tout moment, conformément au RGPD.' },
  { q: 'Puis-je gagner de l\'argent sur Forsure ?', a: 'Oui ! Les créateurs de contenu peuvent monétiser leur audience grâce aux abonnements premium, aux tips (pourboires) de la communauté et au marketplace intégré pour vendre des produits directement à leurs fans.' },
  { q: 'Est-ce que Forsure est sécurisé ?', a: 'Absolument. Forsure utilise le chiffrement pour les communications, une modération IA avancée pour détecter les contenus inappropriés, et des protections spéciales pour les mineurs. La vérification d\'identité est disponible pour renforcer la confiance.' },
];

export default function Landing() {
  const { user, loading } = useAuth();

  if (user) {
    return <Feed />;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <BrandLogo className="h-10 w-auto animate-pulse" />
          <p className="text-muted-foreground">Chargement...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative flex flex-col overflow-hidden bg-background">
      {/* ═══════════════════ HERO SECTION ═══════════════════ */}
      <section className="relative flex flex-col items-center justify-center px-6 py-20 sm:py-28 overflow-hidden">
        <div 
          className="absolute inset-0 bg-no-repeat bg-cover animate-fade-in"
          style={{ backgroundImage: `url(${loginBg})`, backgroundPosition: 'center 25%' }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/85 to-background/50" />

        <div className="relative z-10 max-w-3xl mx-auto text-center animate-fade-in">
          <div className="flex items-center justify-center mb-8">
            <BrandLogo className="h-20 sm:h-28 md:h-32 w-auto drop-shadow-[0_0_40px_hsl(220,70%,50%,0.5)]" />
          </div>
          
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-display font-bold tracking-tight text-foreground mb-5 leading-tight">
            Le réseau social éthique,{' '}
            <span className="text-gradient-gold">sans publicité ni tracking</span>
          </h1>
          
          <p className="text-lg sm:text-xl text-muted-foreground mb-8 max-w-2xl mx-auto leading-relaxed">
            Forsure est l'alternative française à Facebook, Instagram et TikTok. 
            Messagerie privée, live streaming gratuit, marketplace et canaux TV — 
            le tout sans exploiter vos données personnelles.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-3 max-w-sm sm:max-w-md mx-auto justify-center">
            <Link to="/signup">
              <Button size="lg" className="w-full sm:w-auto premium-button text-base px-8">
                <Sparkles className="w-4 h-4 mr-2" />
                Créer mon compte gratuit
              </Button>
            </Link>
            <Link to="/login">
              <Button size="lg" variant="outline" className="w-full sm:w-auto border-border/50 bg-background/30 backdrop-blur-sm hover:bg-background/50 text-base px-8">
                Se connecter
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* ═══════════════════ INTRO SEO TEXT ═══════════════════ */}
      <section className="px-6 py-16 sm:py-20">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground mb-6">
            Pourquoi choisir Forsure comme réseau social ?
          </h2>
          <p className="text-muted-foreground leading-relaxed text-base sm:text-lg">
            Dans un monde où les réseaux sociaux traditionnels exploitent vos données personnelles pour vendre de la publicité ciblée, 
            Forsure propose une approche radicalement différente. Notre plateforme sociale a été conçue dès le départ pour respecter 
            votre vie privée. Pas de cookies de tracking, pas de publicités intrusives, pas d'algorithmes conçus pour vous rendre 
            dépendant. Forsure est un réseau social éthique qui place l'humain au centre de l'expérience.
          </p>
          <p className="text-muted-foreground leading-relaxed text-base sm:text-lg mt-4">
            Que vous cherchiez une alternative à Facebook pour rester en contact avec vos proches, une alternative à Instagram 
            pour partager vos photos et vidéos, ou une alternative à TikTok pour créer du contenu créatif — Forsure réunit 
            toutes ces fonctionnalités dans une seule application, gratuite et sans compromis sur votre vie privée.
          </p>
        </div>
      </section>

      {/* ═══════════════════ FEATURES ═══════════════════ */}
      <section className="px-6 py-16 sm:py-20 bg-muted/20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground text-center mb-4">
            Toutes les fonctionnalités dont vous avez besoin
          </h2>
          <p className="text-muted-foreground text-center mb-12 max-w-2xl mx-auto">
            Forsure est une plateforme sociale complète qui combine messagerie privée, live streaming, 
            partage de vidéos, marketplace et bien plus — le tout sans publicité.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f) => (
              <div key={f.title} className="p-6 rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm hover:border-primary/30 transition-colors">
                <f.icon className="w-8 h-8 text-primary mb-4" />
                <h3 className="text-lg font-semibold text-foreground mb-2">{f.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════ ADVANTAGES / DIFFERENTIATION ═══════════════════ */}
      <section className="px-6 py-16 sm:py-20">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground text-center mb-4">
            Ce qui rend Forsure unique
          </h2>
          <p className="text-muted-foreground text-center mb-12 max-w-2xl mx-auto">
            Forsure n'est pas un énième réseau social. C'est une plateforme sociale éthique, 
            conçue en France, qui respecte réellement votre vie privée.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {advantages.map((a) => (
              <div key={a.title} className="flex gap-4 p-5 rounded-xl border border-border/30 bg-card/30">
                <div className="shrink-0 w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                  <a.icon className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground mb-1">{a.title}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">{a.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════ COMPARISON SECTION ═══════════════════ */}
      <section className="px-6 py-16 sm:py-20 bg-muted/20">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground text-center mb-6">
            Forsure vs les réseaux sociaux traditionnels
          </h2>
          <p className="text-muted-foreground text-center mb-10">
            Découvrez pourquoi des milliers d'utilisateurs choisissent Forsure comme alternative aux plateformes sociales classiques.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 text-muted-foreground font-medium">Critère</th>
                  <th className="text-center py-3 px-4 text-primary font-bold">Forsure</th>
                  <th className="text-center py-3 px-4 text-muted-foreground font-medium">Autres</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                {[
                  ['Publicité', '❌ Aucune', '✅ Omniprésente'],
                  ['Tracking', '❌ Aucun', '✅ Cookies & trackers'],
                  ['Vente de données', '❌ Jamais', '✅ Modèle économique'],
                  ['Messagerie privée', '✅ Intégrée', '✅ Intégrée'],
                  ['Live streaming', '✅ Gratuit', '⚠️ Limité / payant'],
                  ['Marketplace', '✅ Intégré', '⚠️ Séparé'],
                  ['Canaux TV', '✅ Inclus', '❌ Non disponible'],
                  ['Open & éthique', '✅ Oui', '❌ Non'],
                ].map(([criterion, forsure, others]) => (
                  <tr key={criterion} className="border-b border-border/30">
                    <td className="py-3 px-4 font-medium">{criterion}</td>
                    <td className="py-3 px-4 text-center">{forsure}</td>
                    <td className="py-3 px-4 text-center text-muted-foreground">{others}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ═══════════════════ CTA SECTION ═══════════════════ */}
      <section className="px-6 py-16 sm:py-20">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground mb-4">
            Rejoignez le réseau social de nouvelle génération
          </h2>
          <p className="text-muted-foreground mb-8 text-base sm:text-lg">
            Inscription gratuite en 30 secondes. Pas de carte bancaire requise. 
            Commencez à partager, streamer et échanger en toute liberté.
          </p>
          <Link to="/signup">
            <Button size="lg" className="premium-button text-base px-10">
              <Sparkles className="w-4 h-4 mr-2" />
              Rejoindre Forsure gratuitement
            </Button>
          </Link>
        </div>
      </section>

      {/* ═══════════════════ FAQ SEO ═══════════════════ */}
      <section className="px-6 py-16 sm:py-20 bg-muted/20">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground text-center mb-10">
            Questions fréquentes sur Forsure
          </h2>
          <div className="space-y-3">
            {faqItems.map((item) => (
              <FAQItem key={item.q} question={item.q} answer={item.a} />
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════ SEO BOTTOM TEXT ═══════════════════ */}
      <section className="px-6 py-12 sm:py-16">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-xl sm:text-2xl font-bold text-foreground mb-4">
            Un réseau social français, éthique et gratuit
          </h2>
          <p className="text-muted-foreground leading-relaxed text-sm sm:text-base">
            Forsure est né d'une conviction simple : un réseau social peut exister sans exploiter ses utilisateurs. 
            Conçu et hébergé en France, Forsure respecte le RGPD et toutes les réglementations européennes. 
            Notre modèle économique repose sur des abonnements premium optionnels pour les créateurs de contenu, 
            et non sur la vente de vos données personnelles. Que vous soyez un particulier qui souhaite rester 
            en contact avec ses proches, un créateur de contenu à la recherche d'une plateforme de live streaming 
            gratuite, ou un vendeur qui veut lancer sa boutique en ligne sur un marketplace social — Forsure 
            est la plateforme qu'il vous faut. Rejoignez des milliers d'utilisateurs qui ont déjà fait le choix 
            d'un réseau social respectueux de leur vie privée.
          </p>
        </div>
      </section>

      {/* ═══════════════════ FOOTER ═══════════════════ */}
      <footer className="relative z-10 w-full border-t border-border bg-background/80 backdrop-blur-md py-8 px-6">
        <nav className="max-w-3xl mx-auto flex flex-col items-center gap-4">
          <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-6">
            <a href="https://forsure.fans/privacy" className="text-base font-semibold text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
              🔒 Politique de confidentialité
            </a>
            <a href="https://forsure.fans/legal" className="text-base font-semibold text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
              📜 Conditions Générales d'Utilisation
            </a>
          </div>
          <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} Forsure — Réseau social éthique français — Contact : <a href="mailto:dpo@forsure.fans" className="underline">dpo@forsure.fans</a></p>
        </nav>
      </footer>
    </div>
  );
}
