import { Link } from 'react-router-dom';
import { Brain, Eye, MessageSquareWarning, ShieldAlert, Clock, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SEOPageLayout } from '@/components/seo/SEOPageLayout';

const capabilities = [
  { icon: Eye, title: 'Détection en temps réel', desc: 'Les contenus toxiques, le harcèlement et les discours de haine sont identifiés et supprimés avant d\'apparaître dans votre fil d\'actualité.' },
  { icon: MessageSquareWarning, title: 'Anti-harcèlement intelligent', desc: 'L\'IA reconnaît les schémas de harcèlement — messages répétés, insultes déguisées, intimidation — et intervient automatiquement pour protéger la victime.' },
  { icon: ShieldAlert, title: 'Protection anti-arnaque', desc: 'Les tentatives de phishing, les faux profils et les arnaques sont détectés grâce à l\'analyse comportementale et supprimés immédiatement.' },
  { icon: Brain, title: 'Apprentissage continu', desc: 'Zeus s\'améliore en permanence. Chaque signalement et chaque décision de modération enrichissent son intelligence pour une détection toujours plus précise.' },
  { icon: Clock, title: 'Intervention immédiate', desc: 'Là où d\'autres plateformes mettent des jours à traiter un signalement, Zeus agit en quelques millisecondes, avant que le contenu nocif n\'atteigne sa cible.' },
  { icon: Gauge, title: 'Score de confiance', desc: 'Chaque utilisateur dispose d\'un score de confiance transparent qui reflète son comportement. Les comptes fiables sont valorisés.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Modération par intelligence artificielle — Forsure',
  description: 'Zeus, l\'IA de modération de Forsure, détecte et bloque le harcèlement, les arnaques et les contenus toxiques en temps réel.',
  url: 'https://forsure.fans/ia-moderation',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOModeration() {
  return (
    <SEOPageLayout
      title="Modération par intelligence artificielle — Réseau social sans harcèlement"
      description="Zeus, l'IA de modération de Forsure, détecte et bloque le harcèlement, les arnaques et les contenus toxiques en temps réel. Un réseau social sûr pour tous les utilisateurs."
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Brain className="w-4 h-4" /> Intelligence artificielle de modération
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">Une IA de modération qui vous protège en temps réel</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Zeus, notre intelligence artificielle de modération, veille sur la communauté Forsure 24h/24 pour que chaque interaction reste saine et respectueuse.</p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
            {capabilities.map(c => (
              <div key={c.title} className="bg-card border border-border/50 rounded-2xl p-6">
                <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4"><c.icon className="w-5 h-5 text-primary" /></div>
                <h3 className="font-semibold text-foreground mb-2">{c.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{c.desc}</p>
              </div>
            ))}
          </div>

          <div className="max-w-3xl mx-auto space-y-6 text-muted-foreground leading-relaxed">
            <h2 className="text-2xl font-bold text-foreground">Comment Zeus protège la communauté Forsure</h2>
            <p>Quand vous publiez un contenu ou envoyez un message, Zeus l'analyse instantanément. Si le contenu est sain, il est publié normalement. Si Zeus détecte un risque — insulte, menace, arnaque, contenu inapproprié — il le bloque automatiquement et notifie l'équipe de modération pour un examen humain complémentaire.</p>
            <p>Cette double vérification — automatique puis humaine — garantit à la fois une réactivité immédiate et un jugement nuancé. L'intelligence artificielle ne remplace pas l'humain : elle le complète en filtrant les menaces les plus évidentes.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Bien plus efficace que la modération classique</h2>
            <p>Sur Facebook, Instagram ou TikTok, la modération fonctionne principalement par signalement : un contenu toxique reste visible pendant des heures ou des jours avant d'être examiné. Sur Forsure, Zeus agit <strong className="text-foreground">avant la publication</strong>. Le contenu nocif n'atteint jamais votre fil d'actualité. C'est la différence entre éteindre un incendie et empêcher qu'il ne se déclenche.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Respect de la liberté d'expression</h2>
            <p>Zeus ne censure pas les opinions. Il cible uniquement les comportements objectivement nuisibles : harcèlement, menaces, discours de haine, arnaques et contenus illégaux. Les débats, les critiques et les discussions passionnées restent les bienvenus sur Forsure. L'objectif est de créer un espace de discussion libre mais respectueux.</p>

            <p className="mt-6">Découvrez comment Forsure protège également vos données avec une <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée</Link> et une <Link to="/protection-donnees" className="text-primary hover:underline">protection avancée des données personnelles</Link>.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Rejoindre un réseau social respectueux</Button></Link>
            </div>
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
