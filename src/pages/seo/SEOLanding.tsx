import { Link } from 'react-router-dom';
import { Shield, MessageCircle, Sparkles, Users, Zap, Lock, Eye, Brain, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SEOPageLayout } from '@/components/seo/SEOPageLayout';
import { useState } from 'react';

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border/50 rounded-xl overflow-hidden" itemScope itemProp="mainEntity" itemType="https://schema.org/Question">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between p-5 text-left hover:bg-muted/30 transition-colors">
        <span className="font-semibold text-foreground pr-4" itemProp="name">{q}</span>
        <ChevronDown className={`w-5 h-5 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-5 pb-5 text-muted-foreground leading-relaxed" itemScope itemProp="acceptedAnswer" itemType="https://schema.org/Answer"><div itemProp="text">{a}</div></div>}
    </div>
  );
}

const features = [
  { icon: Lock, title: 'Messagerie chiffrée', desc: 'Vos conversations sont protégées par un chiffrement de bout en bout. Personne, pas même Forsure, ne peut lire vos messages.', link: '/messagerie-chiffree' },
  { icon: Shield, title: 'Réseau social sécurisé', desc: 'Nous bloquons les tentatives de piratage, les intrusions et les cyberattaques en temps réel pour protéger votre compte.', link: '/reseau-social-securise' },
  { icon: Brain, title: 'Modération par IA', desc: 'Notre intelligence artificielle détecte et supprime les contenus toxiques avant qu\'ils n\'atteignent votre fil d\'actualité.', link: '/ia-moderation' },
  { icon: Users, title: 'Protection des données', desc: 'Vos données personnelles restent les vôtres. Zéro revente, zéro tracking, zéro publicité ciblée.', link: '/protection-donnees' },
  { icon: Sparkles, title: 'Feed intelligent', desc: 'Un algorithme transparent qui vous montre ce qui compte vraiment, sans manipulation ni publicité cachée.', link: '/feed-intelligent' },
  { icon: Eye, title: 'Zéro tracking', desc: 'Aucune publicité, aucun cookie de suivi, aucune revente de données. Votre vie privée est sacrée.' },
];

const faqs = [
  { q: 'Forsure est-il vraiment gratuit ?', a: 'Oui, Forsure est 100 % gratuit. Toutes les fonctionnalités — messagerie, appels vidéo, live streaming, marketplace — sont accessibles sans abonnement et sans publicité.' },
  { q: 'Comment Forsure gagne-t-il de l\'argent sans publicité ?', a: 'Forsure propose des abonnements créateur optionnels pour les utilisateurs qui souhaitent des fonctionnalités avancées. Le modèle repose sur la valeur, pas sur la vente de vos données.' },
  { q: 'Mes messages sont-ils vraiment privés ?', a: 'Absolument. Chaque conversation est protégée par un chiffrement de bout en bout utilisant les mêmes standards que Signal (protocoles X3DH et Double Ratchet). Personne ne peut lire vos messages, pas même notre équipe.' },
  { q: 'Comment Forsure protège-t-il les mineurs ?', a: 'Notre intelligence artificielle surveille les interactions en temps réel pour détecter les comportements prédateurs. Les messages d\'inconnus sont bloqués par défaut pour les utilisateurs de moins de 16 ans, et les comptes suspects sont automatiquement signalés.' },
  { q: 'Puis-je migrer depuis Facebook ou Instagram ?', a: 'Oui, l\'inscription prend quelques secondes. Vous pouvez importer vos contacts et retrouver vos proches sur Forsure instantanément.' },
  { q: 'Forsure est-il disponible sur mobile ?', a: 'Forsure fonctionne sur tous les navigateurs comme une application web. Des versions iOS et Android sont également disponibles. Vous pouvez l\'installer directement depuis votre navigateur.' },
  { q: 'En quoi Forsure est différent des autres réseaux sociaux ?', a: 'Forsure ne collecte aucune donnée personnelle à des fins publicitaires, ne vend rien à des tiers et n\'utilise aucun cookie de suivi. L\'algorithme est transparent et conçu pour votre bien-être, pas pour maximiser votre temps d\'écran.' },
  { q: 'Y a-t-il un marketplace sur Forsure ?', a: 'Oui, notre marketplace intégré vous permet d\'acheter et vendre des produits en toute sécurité, avec paiement sécurisé et livraison via Mondial Relay.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      name: 'Forsure',
      url: 'https://forsure.fans',
      description: 'Réseau social sécurisé et gratuit sans publicité. Messagerie chiffrée, modération IA, protection des données.',
      potentialAction: {
        '@type': 'SearchAction',
        target: 'https://forsure.fans/search?q={search_term_string}',
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@type': 'WebApplication',
      name: 'Forsure',
      url: 'https://forsure.fans',
      applicationCategory: 'SocialNetworkingApplication',
      operatingSystem: 'Web, iOS, Android',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
      featureList: 'Messagerie chiffrée, Live streaming, Marketplace, Appels vidéo, Feed intelligent, Modération IA',
    },
    {
      '@type': 'Organization',
      name: 'Forsure',
      url: 'https://forsure.fans',
      logo: 'https://forsure.fans/icon-512.png',
      sameAs: ['https://twitter.com/forsure'],
    },
  ],
};

export default function SEOLanding() {
  return (
    <SEOPageLayout
      title="À propos de Forsure — Mission du réseau social éthique français"
      description="Découvrez la mission de Forsure : un réseau social éthique français, 100% gratuit, sans publicité ni tracking. Une alternative respectueuse à Facebook, Instagram et TikTok."
      url="https://forsure.fans/a-propos"
      jsonLd={jsonLd}
    >
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent" />
        <div className="max-w-5xl mx-auto px-4 pt-16 pb-20 md:pt-24 md:pb-28 text-center relative">
          <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-6">
            <Zap className="w-4 h-4" /> Réseau social sécurisé nouvelle génération
          </div>
          <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-foreground leading-tight mb-6">
            Le réseau social <span className="text-primary">sécurisé</span> et <span className="text-primary">gratuit</span> qui protège votre vie privée
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-3xl mx-auto mb-8 leading-relaxed">
            Forsure est l'alternative française à Facebook, Instagram et TikTok. Zéro publicité, zéro tracking, messagerie chiffrée de bout en bout, intelligence artificielle de modération. Reprenez le contrôle de votre vie numérique.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link to="/signup">
              <Button size="lg" className="text-base px-8 w-full sm:w-auto">Créer mon compte gratuit</Button>
            </Link>
            <Link to="/login">
              <Button size="lg" variant="outline" className="text-base px-8 w-full sm:w-auto">Se connecter</Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Pourquoi Forsure */}
      <section className="py-16 md:py-24 bg-muted/20">
        <div className="max-w-6xl mx-auto px-4">
          <div className="text-center mb-12">
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-4">Pourquoi choisir Forsure, le réseau social sécurisé ?</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">Un réseau social conçu pour les utilisateurs, pas pour les annonceurs. Chaque fonctionnalité est pensée pour votre sécurité et votre bien-être numérique.</p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map(f => {
              const Wrapper = f.link ? Link : 'div';
              const props = f.link ? { to: f.link } : {};
              return (
                <Wrapper key={f.title} {...(props as any)} className="group bg-card border border-border/50 rounded-2xl p-6 hover:border-primary/40 hover:shadow-lg transition-all">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/20 transition-colors">
                    <f.icon className="w-6 h-6 text-primary" />
                  </div>
                  <h3 className="font-semibold text-foreground mb-2">{f.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
                </Wrapper>
              );
            })}
          </div>
        </div>
      </section>

      {/* Contenu riche SEO */}
      <section className="py-16 md:py-24">
        <div className="max-w-4xl mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-6">Un réseau social sécurisé pensé pour vous, pas pour les annonceurs</h2>

          <div className="space-y-4 text-muted-foreground leading-relaxed">
            <p>
              Les réseaux sociaux traditionnels — Facebook, Instagram, TikTok, X (Twitter) — fonctionnent tous selon le même modèle : collecter vos données personnelles pour les revendre à des annonceurs. Chaque like, chaque commentaire, chaque minute passée sur l'application est analysée, mesurée et monétisée. Votre attention est le produit. Vos données personnelles sont la monnaie d'échange.
            </p>
            <p>
              <strong className="text-foreground">Forsure change la donne.</strong> Créé en France, Forsure est un réseau social sécurisé entièrement gratuit qui ne diffuse aucune publicité, ne vend aucune donnée et ne vous traque pas à travers le web. Nous pensons qu'un réseau social doit servir ses utilisateurs, pas ses actionnaires. C'est pourquoi nous avons construit une plateforme où la sécurité, la confidentialité et le respect de la vie privée ne sont pas des options payantes, mais des droits fondamentaux.
            </p>

            <h2 className="text-xl md:text-2xl font-bold text-foreground mt-10 mb-4">Une messagerie chiffrée vraiment privée</h2>
            <p>
              Sur Forsure, chaque message est protégé par un <strong className="text-foreground">chiffrement de bout en bout</strong>. Concrètement, vos conversations sont verrouillées par une clé unique que seuls vous et votre correspondant possédez. Personne d'autre — ni Forsure, ni un pirate informatique, ni une agence gouvernementale — ne peut les lire. Nous utilisons les mêmes protocoles de sécurité que l'application Signal, reconnue mondialement comme la référence en matière de confidentialité des communications.
            </p>
            <p>
              Contrairement aux messageries de Facebook Messenger ou Instagram Direct, où vos messages transitent en clair sur les serveurs de Meta et peuvent être analysés à des fins publicitaires, la <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée de Forsure</Link> garantit que vos conversations restent strictement privées.
            </p>

            <h2 className="text-xl md:text-2xl font-bold text-foreground mt-10 mb-4">Une intelligence artificielle au service de votre sécurité</h2>
            <p>
              Notre <Link to="/ia-moderation" className="text-primary hover:underline">IA de modération</Link>, baptisée Zeus, analyse les contenus publiés en temps réel pour détecter le harcèlement, les discours de haine, les arnaques et les contenus inappropriés. Contrairement aux autres plateformes qui modèrent a posteriori (après signalement), Forsure agit <strong className="text-foreground">avant que le contenu toxique n'atteigne votre fil d'actualité</strong>. Cette approche proactive élimine la quasi-totalité des contenus nuisibles avant même qu'ils ne soient visibles.
            </p>
            <p>
              Pour les utilisateurs de moins de 16 ans, la <Link to="/protection-donnees" className="text-primary hover:underline">protection est encore plus stricte</Link> : les messages d'inconnus sont bloqués par défaut, et l'IA détecte automatiquement les tentatives de manipulation (grooming) avec un seuil de sensibilité renforcé. Les parents disposent d'un tableau de bord de contrôle parental pour superviser l'activité de leurs enfants en toute sérénité.
            </p>

            <h2 className="text-xl md:text-2xl font-bold text-foreground mt-10 mb-4">Toutes les fonctionnalités que vous aimez, sans les inconvénients</h2>
            <p>
              Forsure rassemble tout ce que vous utilisez déjà sur les autres réseaux — fil d'actualité, stories, live streaming, appels vidéo, groupes, marketplace — dans une seule application éthique et sécurisée. Pas besoin de jongler entre plusieurs apps : tout est intégré, fluide et protégé.
            </p>
            <ul className="space-y-2">
              <li>📱 <strong className="text-foreground">Stories et Reels</strong> — Partagez vos moments en photo et vidéo</li>
              <li>🎥 <strong className="text-foreground">Live streaming</strong> — Diffusez en direct et interagissez avec votre communauté</li>
              <li>📞 <strong className="text-foreground">Appels vidéo HD</strong> — Appelez vos proches gratuitement en haute qualité</li>
              <li>🛍️ <strong className="text-foreground">Marketplace sécurisé</strong> — Achetez et vendez en toute confiance</li>
              <li>🎮 <strong className="text-foreground">Jeux multijoueur</strong> — Jouez avec vos amis directement dans l'app</li>
              <li>🤖 <strong className="text-foreground">Assistants IA</strong> — Des agents intelligents pour vous aider au quotidien</li>
            </ul>

            <h2 className="text-xl md:text-2xl font-bold text-foreground mt-10 mb-4">Un algorithme de feed transparent et bienveillant</h2>
            <p>
              L'<Link to="/feed-intelligent" className="text-primary hover:underline">algorithme de feed intelligent</Link> de Forsure ne cherche pas à maximiser votre temps d'écran. Il est conçu pour vous montrer les contenus qui comptent vraiment : les publications de vos amis, les actualités de vos groupes, les créateurs que vous suivez. Pas de contenu sponsorisé déguisé, pas de manipulation émotionnelle, pas de dark patterns. Vous gardez le contrôle de ce que vous voyez.
            </p>

            <h2 className="text-xl md:text-2xl font-bold text-foreground mt-10 mb-4">Protégé contre les cyberattaques</h2>
            <p>
              Forsure intègre des <Link to="/reseau-social-securise" className="text-primary hover:underline">protections de niveau entreprise</Link> contre les menaces en ligne : les tentatives de piratage de compte, les attaques par surcharge de serveur et les injections de code malveillant sont automatiquement bloquées. Votre compte est protégé 24h/24, 7j/7 par notre bouclier de sécurité avancé. Contrairement aux plateformes qui découvrent les failles après une violation de données, Forsure anticipe et neutralise les menaces en amont.
            </p>

            <h2 className="text-xl md:text-2xl font-bold text-foreground mt-10 mb-4">Rejoignez le mouvement pour un internet plus éthique</h2>
            <p>
              Des milliers d'utilisateurs ont déjà choisi Forsure pour reprendre le contrôle de leur vie numérique. L'inscription est gratuite, prend moins de 30 secondes, et ne nécessite aucune carte bancaire. Rejoignez une communauté qui place l'humain avant le profit et la sécurité avant la monétisation.
            </p>

            <div className="text-center pt-6">
              <Link to="/signup">
                <Button size="lg" className="text-base px-8">Rejoindre Forsure gratuitement</Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 md:py-24 bg-muted/20" itemScope itemType="https://schema.org/FAQPage">
        <div className="max-w-3xl mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-center mb-10">Questions fréquentes sur Forsure</h2>
          <div className="space-y-3">
            {faqs.map(f => <FAQItem key={f.q} q={f.q} a={f.a} />)}
          </div>
        </div>
      </section>

      {/* CTA final */}
      <section className="py-16 md:py-20">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-4">Prêt à rejoindre un réseau social sécurisé ?</h2>
          <p className="text-muted-foreground mb-8">Rejoignez Forsure dès maintenant. C'est gratuit, éthique et respectueux de votre vie privée.</p>
          <Link to="/signup">
            <Button size="lg" className="text-base px-10">Créer mon compte</Button>
          </Link>
        </div>
      </section>
    </SEOPageLayout>
  );
}
