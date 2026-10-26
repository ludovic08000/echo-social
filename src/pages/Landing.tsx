import { Link } from 'react-router-dom';
import { Sparkles, Shield, MessageCircle, Video, Store, Tv, Users, Zap, Lock, Heart, Globe, ChevronDown } from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { SEOHead } from '@/components/SEOHead';
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
  { icon: MessageCircle, title: 'Messagerie privée', desc: 'Échangez avec vos proches. Messages texte, vocaux et appels vidéo intégrés.' },
  { icon: Video, title: 'Live streaming créateur', desc: 'Les créateurs abonnés peuvent lancer un live et interagir avec leur audience en temps réel.' },
  { icon: Tv, title: 'Canaux TV personnalisés', desc: 'Créez votre propre chaîne, publiez du contenu vidéo et construisez votre communauté de fans.' },
  { icon: Store, title: 'Marketplace intégré', desc: 'Vendez et achetez directement sur la plateforme. Paiement sécurisé et suivi de livraison inclus.' },
  { icon: Shield, title: 'Vie privée respectée', desc: 'Pas de revente de données. La personnalisation publicitaire est facultative et distincte des recommandations du feed.' },
  { icon: Users, title: 'Communauté bienveillante', desc: 'Modération IA avancée, protection des mineurs et outils anti-harcèlement intégrés.' },
];

const advantages = [
  { icon: Lock, title: 'Des choix transparents', desc: 'Les publicités sont identifiées. Leurs réglages de personnalisation sont distincts de vos choix pour le fil d\'actualité.' },
  { icon: Heart, title: 'Éthique par design', desc: 'Pas d\'algorithme addictif. Forsure privilégie votre bien-être numérique avec des outils de détox et de contrôle du temps d\'écran.' },
  { icon: Zap, title: 'Tout-en-un', desc: 'Messagerie, live, vidéos, marketplace, jeux, challenges... Tout ce dont vous avez besoin, dans une seule application.' },
  { icon: Globe, title: 'Une initiative française', desc: 'Retrouvez les informations sur les données, les prestataires techniques et vos droits dans la politique de confidentialité.' },
];

const faqItems = [
  { q: 'Forsure est-il gratuit ?', a: 'L\'inscription, la messagerie, le visionnage des lives, les jeux multijoueurs et les fonctionnalités sociales de base sont accessibles sans frais. La diffusion d\'un live est réservée aux créateurs disposant d\'un abonnement actif.' },
  { q: 'En quoi Forsure est différent de Facebook ou Instagram ?', a: 'Forsure associe un fil d\'actualité réglable, des outils de bien-être et une messagerie privée chiffrée. La personnalisation publicitaire est facultative et séparée des recommandations. Le service comprend aussi un marketplace, des jeux, des lives, des défis et un assistant IA (Zeus).' },
  { q: 'Comment mes messages sont-ils protégés ?', a: 'Les conversations privées 1-à-1 utilisent Libsignal avec PQXDH + Double Ratchet. Une sauvegarde de continuité peut conserver un coffre chiffré contenant les clés, sans les transmettre en clair. Vous pouvez vérifier les empreintes de vos contacts et protéger l\'accès local par un PIN. N\'effacez pas le navigateur sans avoir vérifié la sauvegarde et la restauration.' },
  { q: 'Comment Forsure protège ma vie privée ?', a: 'Vous pouvez régler la visibilité de votre profil et de vos publications, ainsi que les choix de personnalisation. La session web utilise localStorage, accessible au JavaScript du site, et non un cookie HttpOnly. Les paramètres proposent l\'export et la demande de suppression ; les copies, médias et conservations légales nécessitent un suivi distinct. La politique de confidentialité décrit ces traitements.' },
  { q: 'Comment les utilisateurs sont-ils protégés ?', a: 'Forsure combine signalement, blocage, modération des contenus et outils de bien-être numérique. Le contrôle parental par code PIN est désactivé et n’impose plus de restriction au compte, au feed ou à la messagerie.' },
  { q: 'Forsure est-il sécurisé contre les attaques ?', a: 'Oui. Forsure dispose d\'une protection DDoS avec rate limiting adaptatif et pénalités progressives, d\'une IA de monitoring de sécurité (SOC) auto-apprenante qui analyse les menaces en temps réel, d\'un score de confiance (Trust Score) pour détecter les comportements suspects, et d\'une politique CSP stricte contre les injections de scripts. Les inscriptions sont protégées par vérification MX, honeypot anti-bot et politique de mot de passe stricte.' },
  { q: 'Forsure est-il disponible sur mobile ?', a: 'Forsure est accessible dans les navigateurs mobiles et comme application web progressive (PWA). La disponibilité d\'une application native dépend de sa publication effective dans les boutiques ; une compilation de test ne constitue pas une publication.' },
  { q: 'Puis-je gagner de l\'argent sur Forsure ?', a: 'Oui ! Les créateurs peuvent monétiser leur audience grâce aux abonnements premium, aux tips (pourboires) de la communauté et au marketplace intégré avec suivi de commande, négociation de prix et coach IA vendeur. Les paiements sont traités de manière sécurisée via Stripe — Forsure ne stocke aucune donnée bancaire.' },
  { q: 'Qu\'est-ce que Zeus, l\'assistant IA ?', a: 'Zeus répond à vos demandes, vous aide à créer du contenu et accompagne les vendeurs. Les demandes adressées aux fonctionnalités IA peuvent être transmises à un prestataire via la passerelle IA. N\'y saisissez pas de secrets ou de données sensibles inutiles.' },
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
    <div className="min-h-screen relative flex flex-col overflow-x-hidden bg-background">
      <SEOHead
        title="Réseau social — Votre fil, vos choix"
        description="Forsure : un réseau social avec un fil réglable, des outils de bien-être et une messagerie privée. Inscription gratuite, choix de personnalisation distincts."
        url="https://forsure.fans/"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'Forsure',
          alternateName: 'Forsure — Réseau social éthique',
          url: 'https://forsure.fans/',
          description: "Forsure : un fil réglable, des outils de bien-être et une messagerie privée. Inscription gratuite, choix de personnalisation distincts.",
          inLanguage: 'fr-FR',
          publisher: { '@type': 'Organization', name: 'Forsure', url: 'https://forsure.fans' },
          potentialAction: {
            '@type': 'SearchAction',
            target: 'https://forsure.fans/search?q={search_term_string}',
            'query-input': 'required name=search_term_string',
          },
        }}
      />
      {/* ═══════════════════ HERO SECTION ═══════════════════ */}
      <section className="relative flex flex-col items-center justify-center px-4 sm:px-6 py-16 sm:py-28 overflow-hidden">
        <div 
          className="absolute inset-0 bg-no-repeat bg-cover animate-fade-in"
          style={{ backgroundImage: `url(${loginBg})`, backgroundPosition: 'center 25%' }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/85 to-background/50" />

        <div className="relative z-10 w-full max-w-3xl mx-auto text-center animate-fade-in px-2">
          <div className="flex items-center justify-center mb-6 sm:mb-8">
            <BrandLogo className="h-16 sm:h-24 md:h-32 w-auto drop-shadow-[0_0_40px_hsl(220,70%,50%,0.5)]" />
          </div>
          
          <h1 className="text-2xl sm:text-4xl md:text-5xl font-display font-bold tracking-tight text-foreground mb-4 sm:mb-5 leading-tight break-words">
            Le réseau social éthique,{' '}
            <span className="text-gradient-gold">à votre rythme, selon vos choix</span>
          </h1>
          
          <p className="text-base sm:text-xl text-muted-foreground mb-6 sm:mb-8 max-w-2xl mx-auto leading-relaxed">
            Forsure est l'alternative française à Facebook, Instagram et TikTok. 
            Messagerie privée, lives de créateurs, marketplace et canaux TV —
            le tout sans exploiter vos données personnelles.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-3 max-w-sm sm:max-w-md mx-auto justify-center">
            <Link to="/signup">
              <Button size="lg" className="w-full sm:w-auto premium-button text-base px-8">
                <Sparkles className="w-4 h-4 mr-2" />
                Créer mon compte gratuit
              </Button>
            </Link>
            <Link to="/feed">
              <Button size="lg" variant="outline" className="w-full sm:w-auto border-border/50 bg-background/30 backdrop-blur-sm hover:bg-background/50 text-base px-8">
                <Globe className="w-4 h-4 mr-2" />
                Explorer sans compte
              </Button>
            </Link>
          </div>
          <p className="text-xs text-muted-foreground/60 mt-3">Déjà inscrit ? <Link to="/login" className="underline hover:text-foreground transition-colors">Se connecter</Link></p>
        </div>
      </section>

      {/* ═══════════════════ INTRO SEO TEXT ═══════════════════ */}
      <section className="px-4 sm:px-6 py-16 sm:py-20">
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
      <section className="px-4 sm:px-6 py-16 sm:py-20 bg-muted/20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground text-center mb-4">
            Toutes les fonctionnalités dont vous avez besoin
          </h2>
          <p className="text-muted-foreground text-center mb-12 max-w-2xl mx-auto">
            Forsure est une plateforme sociale complète qui combine messagerie privée, live streaming, 
            partage de vidéos, marketplace et bien plus — avec des réglages de personnalisation distincts.
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
      <section className="px-4 sm:px-6 py-16 sm:py-20">
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
      <section className="px-4 sm:px-6 py-16 sm:py-20 bg-muted/20">
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
                  ['Diffusion en direct', '✅ Créateurs abonnés', '⚠️ Limité / payant'],
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
      <section className="px-4 sm:px-6 py-16 sm:py-20">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground mb-4">
            Rejoignez le réseau social de nouvelle génération
          </h2>
          <p className="text-muted-foreground mb-8 text-base sm:text-lg">
            Inscription gratuite en 30 secondes. Pas de carte bancaire requise. 
             Commencez à partager et échanger librement. Les créateurs abonnés peuvent aussi diffuser leurs lives.
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
      <section className="px-4 sm:px-6 py-16 sm:py-20 bg-muted/20">
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
            ForSure est une initiative française utilisant plusieurs prestataires cloud décrits dans sa politique de confidentialité.
            Notre modèle économique comprend des abonnements premium optionnels pour les créateurs de contenu et des publicités identifiées,
            et non sur la vente de vos données personnelles. Que vous soyez un particulier qui souhaite rester 
             en contact avec ses proches, un créateur de contenu à la recherche d'une plateforme de live streaming,
             ou un vendeur qui veut lancer sa boutique en ligne sur un marketplace social — Forsure
            est une plateforme pour vous retrouver. Rejoignez une communauté qui fait le choix
            d'un réseau social respectueux de leur vie privée.
          </p>
        </div>
      </section>

      {/* ═══════════════════ FOOTER ═══════════════════ */}
      <footer className="relative z-10 w-full border-t border-border bg-background/80 backdrop-blur-md py-8 px-6">
        <nav className="max-w-4xl mx-auto flex flex-col items-center gap-5" aria-label="Pied de page Forsure">
          <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-6">
            <a href="https://forsure.fans/privacy" className="text-base font-semibold text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
              🔒 Politique de confidentialité
            </a>
            <a href="https://forsure.fans/legal" className="text-base font-semibold text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
              📜 Conditions Générales d'Utilisation
            </a>
          </div>
          <p className="text-xs text-muted-foreground text-center leading-relaxed max-w-xl">
            <strong>Forsure</strong> — Réseau social français, inscription gratuite et choix de personnalisation.
            Alternative à Facebook, Instagram, TikTok, Snapchat et Twitter/X. 
            Messagerie chiffrée, live streaming, marketplace, appels vidéo, canaux TV, jeux multijoueur. 
            Contact : <a href="mailto:dpo@forsure.fans" className="underline hover:text-primary">dpo@forsure.fans</a>
          </p>
          <p className="text-[10px] text-muted-foreground/60">© {new Date().getFullYear()} Forsure · forsure.fans · Tous droits réservés</p>
        </nav>
      </footer>
    </div>
  );
}
