import { Link } from 'react-router-dom';
import { Brain, Eye, MessageSquareWarning, ShieldAlert, Clock, Gauge, ChevronDown } from 'lucide-react';
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

const capabilities = [
  { icon: Eye, title: 'Détection en temps réel', desc: 'Les contenus toxiques, le harcèlement et les discours de haine sont identifiés et bloqués par notre intelligence artificielle de modération avant d\'apparaître dans votre fil.' },
  { icon: MessageSquareWarning, title: 'Protection contre le harcèlement', desc: 'L\'IA de modération reconnaît les schémas de harcèlement — messages répétés, insultes déguisées, intimidation — et intervient automatiquement pour protéger la victime.' },
  { icon: ShieldAlert, title: 'Détection des arnaques', desc: 'Les tentatives de phishing, les faux profils et les arnaques sont détectés par notre intelligence artificielle de modération et supprimés immédiatement.' },
  { icon: Brain, title: 'Apprentissage continu', desc: 'Notre IA de modération s\'améliore en permanence. Chaque signalement enrichit son intelligence pour une détection toujours plus précise et nuancée.' },
  { icon: Clock, title: 'Action en millisecondes', desc: 'Là où d\'autres plateformes mettent des jours à traiter un signalement, notre intelligence artificielle de modération agit instantanément, avant que le contenu nocif n\'atteigne sa cible.' },
  { icon: Gauge, title: 'Score de confiance transparent', desc: 'Chaque utilisateur dispose d\'un score de confiance qui reflète son comportement. Les comptes fiables sont valorisés par notre IA de modération.' },
];

const faqs = [
  { q: 'Comment fonctionne l\'intelligence artificielle de modération de Forsure ?', a: 'Notre IA de modération, appelée Zeus, analyse chaque contenu publié ou envoyé sur Forsure en temps réel. Si elle détecte du harcèlement, des insultes, des arnaques ou des contenus inappropriés, elle bloque automatiquement le contenu avant qu\'il ne soit visible par les autres utilisateurs.' },
  { q: 'L\'IA de modération censure-t-elle les opinions ?', a: 'Non. Notre intelligence artificielle de modération cible uniquement les comportements objectivement nuisibles : harcèlement, menaces, discours de haine, arnaques et contenus illégaux. Les débats, les critiques constructives et les discussions passionnées restent entièrement libres sur Forsure.' },
  { q: 'L\'IA de modération est-elle plus efficace que le signalement ?', a: 'Oui, considérablement. Sur Facebook ou Instagram, un contenu signalé peut rester visible pendant des heures ou des jours. Notre intelligence artificielle de modération agit avant la publication — le contenu nocif n\'atteint jamais votre fil d\'actualité.' },
  { q: 'Comment l\'IA de modération protège-t-elle les enfants ?', a: 'Pour les utilisateurs de moins de 16 ans, notre intelligence artificielle de modération applique des seuils de sensibilité renforcés. Elle détecte les tentatives de manipulation, bloque les messages d\'inconnus et signale les comportements prédateurs.' },
  { q: 'L\'IA de modération peut-elle se tromper ?', a: 'Comme toute technologie, l\'IA peut parfois faire des erreurs. C\'est pourquoi chaque décision de notre intelligence artificielle de modération est vérifiable par un humain. Les utilisateurs peuvent contester une décision, et notre équipe examine chaque cas avec attention.' },
  { q: 'L\'IA de modération fonctionne-t-elle dans les messages privés ?', a: 'Oui, notre intelligence artificielle de modération analyse les messages pour détecter le harcèlement et les arnaques, tout en respectant votre vie privée. Le contenu de vos messages reste chiffré — seuls les schémas de comportement dangereux sont détectés.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Intelligence artificielle de modération — Forsure',
  description: 'Zeus, l\'IA de modération de Forsure, détecte et bloque le harcèlement, les arnaques et les contenus toxiques en temps réel.',
  url: 'https://forsure.fans/ia-moderation',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOModeration() {
  return (
    <SEOPageLayout
      title="Intelligence artificielle de modération — Réseau social sans harcèlement"
      description="L'intelligence artificielle de modération de Forsure détecte et bloque le harcèlement, les arnaques et les contenus toxiques en temps réel. Un réseau social sûr pour tous les utilisateurs."
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Brain className="w-4 h-4" /> Intelligence artificielle de modération
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">Une intelligence artificielle de modération qui vous protège en temps réel</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Zeus, notre IA de modération, surveille Forsure 24h/24 pour que chaque interaction reste saine, respectueuse et sécurisée.</p>
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
            <h2 className="text-2xl font-bold text-foreground">Pourquoi une intelligence artificielle de modération est indispensable</h2>
            <p>Le harcèlement en ligne est devenu un problème majeur de société. Chaque jour, des millions de personnes — en particulier les jeunes — sont exposées à des insultes, des menaces, des arnaques et des contenus inappropriés sur les réseaux sociaux. Les systèmes de modération traditionnels, basés sur le signalement par les utilisateurs, sont trop lents et trop inefficaces pour protéger les victimes.</p>
            <p>C'est pourquoi Forsure a développé Zeus, une intelligence artificielle de modération capable d'analyser chaque contenu en temps réel et d'intervenir en quelques millisecondes — bien avant que le contenu toxique ne puisse affecter sa cible.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Comment Zeus protège la communauté Forsure</h2>
            <p>Quand vous publiez un contenu ou envoyez un message sur Forsure, notre intelligence artificielle de modération l'analyse instantanément. Si le contenu est sain et respectueux, il est publié normalement. Si Zeus détecte un risque — insulte, menace, arnaque, contenu inapproprié, tentative de manipulation — il le bloque automatiquement.</p>
            <p>Chaque décision de l'IA de modération est ensuite vérifiée par notre équipe humaine de modérateurs. Cette double vérification — automatique puis humaine — garantit à la fois une réactivité instantanée et un jugement nuancé qui respecte la liberté d'expression.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Bien plus efficace que la modération des autres réseaux sociaux</h2>
            <p>Sur Facebook, Instagram ou TikTok, la modération fonctionne principalement par signalement : un utilisateur voit un contenu toxique, le signale, et l'équipe de modération l'examine — parfois des heures ou des jours plus tard. Pendant ce temps, le contenu reste visible et continue de faire du mal.</p>
            <p>L'intelligence artificielle de modération de Forsure renverse cette logique. Elle agit <strong className="text-foreground">avant la publication</strong>. Le contenu nocif n'atteint jamais votre fil d'actualité. C'est la différence entre éteindre un incendie et empêcher qu'il ne se déclenche.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Protection renforcée pour les mineurs</h2>
            <p>Notre intelligence artificielle de modération est particulièrement attentive aux interactions impliquant des mineurs. Pour les utilisateurs de moins de 16 ans, les seuils de détection sont abaissés et l'IA surveille activement les tentatives de manipulation (grooming), les messages suspects d'inconnus et les contenus inappropriés. Cette <Link to="/protection-donnees" className="text-primary hover:underline">protection renforcée des données et des utilisateurs</Link> fait de Forsure l'un des réseaux sociaux les plus sûrs pour les jeunes.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Liberté d'expression et modération intelligente</h2>
            <p>Notre intelligence artificielle de modération ne censure pas les opinions, les débats ou les critiques constructives. Elle cible uniquement les comportements objectivement nuisibles : le harcèlement, les menaces, les discours de haine, les arnaques et les contenus illégaux. L'objectif est de créer un espace de discussion libre mais respectueux, où chacun peut s'exprimer sans crainte.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Une IA de modération qui apprend et s'améliore</h2>
            <p>Zeus n'est pas un système statique. Notre intelligence artificielle de modération apprend en continu grâce aux retours des utilisateurs et aux décisions des modérateurs humains. Chaque signalement, chaque contestation, chaque décision enrichit sa base de connaissances et affine sa capacité à distinguer le contenu acceptable du contenu nuisible.</p>
            <p>Découvrez également notre <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée</Link> pour des conversations privées, et notre <Link to="/reseau-social-securise" className="text-primary hover:underline">système de sécurité avancé</Link> pour une protection complète de votre compte.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Rejoindre un réseau social modéré par IA</Button></Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 md:py-24 bg-muted/20" itemScope itemType="https://schema.org/FAQPage">
        <div className="max-w-3xl mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-center mb-10">Questions fréquentes sur l'IA de modération</h2>
          <div className="space-y-3">
            {faqs.map(f => <FAQItem key={f.q} q={f.q} a={f.a} />)}
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
