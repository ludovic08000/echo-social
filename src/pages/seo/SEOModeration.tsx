import { Link } from 'react-router-dom';
import { Brain, Eye, MessageSquareWarning, ShieldAlert, Clock, Gauge, ChevronDown, CheckCircle } from 'lucide-react';
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
  { icon: Eye, title: 'Détection en temps réel', desc: 'L\'intelligence artificielle de modération Forsure identifie les contenus toxiques, le harcèlement et les discours de haine avant qu\'ils n\'apparaissent dans votre fil d\'actualité.' },
  { icon: MessageSquareWarning, title: 'Protection contre le harcèlement', desc: 'L\'intelligence artificielle de modération reconnaît les schémas de harcèlement — messages répétés, insultes déguisées, intimidation — et intervient automatiquement.' },
  { icon: ShieldAlert, title: 'Détection des arnaques en ligne', desc: 'Les tentatives de phishing, les faux profils et les arnaques sont détectés par l\'intelligence artificielle de modération et supprimés immédiatement.' },
  { icon: Brain, title: 'Apprentissage continu', desc: 'L\'intelligence artificielle de modération s\'améliore en permanence. Chaque signalement enrichit son intelligence pour une détection toujours plus précise.' },
  { icon: Clock, title: 'Action en millisecondes', desc: 'Là où d\'autres plateformes mettent des jours, l\'intelligence artificielle de modération Forsure agit instantanément, avant que le contenu nocif n\'atteigne sa cible.' },
  { icon: Gauge, title: 'Score de confiance transparent', desc: 'L\'intelligence artificielle de modération attribue un score de confiance à chaque utilisateur. Les comptes fiables sont valorisés, les comptes toxiques sont limités.' },
];

const faqs = [
  { q: 'Comment fonctionne l\'intelligence artificielle de modération de Forsure ?', a: 'L\'intelligence artificielle de modération de Forsure, appelée Zeus, analyse chaque contenu publié ou envoyé en temps réel. Si elle détecte du harcèlement, des insultes, des arnaques ou des contenus inappropriés, elle bloque automatiquement le contenu avant qu\'il ne soit visible.' },
  { q: 'L\'intelligence artificielle de modération censure-t-elle les opinions ?', a: 'Non. L\'intelligence artificielle de modération de Forsure cible uniquement les comportements objectivement nuisibles : harcèlement, menaces, discours de haine, arnaques et contenus illégaux. Les débats et les critiques constructives restent entièrement libres.' },
  { q: 'L\'intelligence artificielle de modération est-elle plus efficace que le signalement ?', a: 'Oui, considérablement. Sur Facebook ou Instagram, un contenu signalé peut rester visible pendant des heures. L\'intelligence artificielle de modération de Forsure agit avant la publication — le contenu nocif n\'atteint jamais votre fil.' },
  { q: 'Comment l\'intelligence artificielle de modération protège-t-elle les enfants ?', a: 'L\'intelligence artificielle de modération applique des seuils renforcés pour les mineurs. Elle détecte les tentatives de manipulation, bloque les messages d\'inconnus et signale automatiquement les comportements prédateurs.' },
  { q: 'L\'intelligence artificielle de modération peut-elle se tromper ?', a: 'Chaque décision de l\'intelligence artificielle de modération est vérifiable par un humain. Les utilisateurs peuvent contester une décision, et notre équipe examine chaque cas. L\'IA s\'améliore grâce à ces retours.' },
  { q: 'L\'intelligence artificielle de modération fonctionne-t-elle en plusieurs langues ?', a: 'Oui, l\'intelligence artificielle de modération de Forsure détecte les contenus toxiques en français, anglais, espagnol, allemand et dans de nombreuses autres langues. Elle s\'adapte aux expressions et au contexte culturel.' },
  { q: 'L\'intelligence artificielle de modération fonctionne-t-elle dans les messages privés ?', a: 'L\'intelligence artificielle de modération analyse les messages pour détecter le harcèlement et les arnaques tout en respectant la confidentialité de vos conversations chiffrées.' },
  { q: 'Pourquoi l\'intelligence artificielle de modération est-elle meilleure que la modération humaine seule ?', a: 'L\'intelligence artificielle de modération peut analyser des milliers de contenus par seconde, 24h/24, sans fatigue ni biais. Elle complète le travail des modérateurs humains en filtrant les menaces les plus évidentes instantanément.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Intelligence artificielle de modération — Réseau social sans harcèlement — Forsure',
  description: 'L\'intelligence artificielle de modération de Forsure détecte et bloque le harcèlement, les arnaques et les contenus toxiques en temps réel.',
  url: 'https://forsure.fans/ia-moderation',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOModeration() {
  return (
    <SEOPageLayout
      title="Modération IA bienveillante — Réseau social sain sans harcèlement"
      description="Modération IA bienveillante sur Forsure : un réseau social sain où le harcèlement, les arnaques et les contenus toxiques sont détectés et bloqués en temps réel par Zeus, notre IA éthique."
      url="https://forsure.fans/ia-moderation"
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Brain className="w-4 h-4" /> Intelligence artificielle de modération
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">L'intelligence artificielle de modération qui protège votre expérience en ligne</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Zeus, l'intelligence artificielle de modération de Forsure, veille 24h/24 pour que chaque interaction reste saine, respectueuse et sécurisée.</p>
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
            <h2 className="text-2xl font-bold text-foreground">Pourquoi une intelligence artificielle de modération est devenue indispensable</h2>
            <p>Le harcèlement en ligne est devenu un problème majeur de société. Selon les études récentes, plus de 40 % des utilisateurs de réseaux sociaux ont déjà été victimes de harcèlement en ligne. Les arnaques, les discours de haine et les contenus inappropriés se propagent à une vitesse que les modérateurs humains ne peuvent tout simplement pas suivre.</p>
            <p>L'intelligence artificielle de modération de Forsure a été créée pour répondre à cette réalité. Notre IA, baptisée Zeus, peut analyser des milliers de contenus par seconde — textes, images, vidéos, commentaires — et prendre des décisions de modération en quelques millisecondes. C'est la seule façon de protéger efficacement une communauté en ligne en 2025.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">L'échec de la modération traditionnelle</h3>
            <p>La modération traditionnelle, basée sur le signalement par les utilisateurs, est fondamentalement défaillante. Voici pourquoi l'intelligence artificielle de modération est la seule solution viable :</p>
            <ul className="space-y-2">
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Délai inacceptable</strong> — Un contenu signalé sur Facebook met en moyenne 24 à 48 heures avant d'être examiné. L'intelligence artificielle de modération agit en millisecondes.</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Victimes exposées</strong> — Pendant que le contenu attend d'être modéré, il continue de faire du mal. L'intelligence artificielle de modération le bloque avant publication.</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Volume impossible</strong> — Des millions de contenus sont publiés chaque minute. Seule l'intelligence artificielle de modération peut traiter ce volume.</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Disponibilité constante</strong> — L'intelligence artificielle de modération fonctionne 24h/24, 7j/7, sans fatigue ni pause.</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Comment l'intelligence artificielle de modération Zeus protège la communauté</h2>
            <p>L'intelligence artificielle de modération de Forsure analyse chaque contenu à plusieurs niveaux avant de prendre une décision :</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Analyse du texte par l'intelligence artificielle de modération</h3>
            <p>L'intelligence artificielle de modération examine le texte de chaque message, commentaire et publication pour détecter les insultes, les menaces, les discours de haine, les tentatives de manipulation et les arnaques. Elle comprend le contexte, les sous-entendus et les formulations déguisées. Un harceleur qui utilise des euphémismes ou des codes ne trompe pas l'intelligence artificielle de modération.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Analyse des comportements par l'intelligence artificielle de modération</h3>
            <p>Au-delà du contenu individuel, l'intelligence artificielle de modération analyse les schémas de comportement. Un utilisateur qui envoie 50 messages identiques à des inconnus, qui cible systématiquement des profils de mineurs, ou qui crée plusieurs comptes pour contourner un blocage est automatiquement détecté et neutralisé par l'intelligence artificielle de modération.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Vérification humaine complémentaire</h3>
            <p>L'intelligence artificielle de modération ne remplace pas le jugement humain — elle le complète. Chaque décision de blocage peut être contestée par l'utilisateur et examinée par un modérateur humain. Cette double vérification garantit l'équilibre entre protection efficace et respect de la liberté d'expression.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">L'intelligence artificielle de modération vs la modération de Facebook, Instagram et TikTok</h2>
            <p>Sur Facebook, Instagram et TikTok, la modération repose principalement sur les signalements des utilisateurs. Un contenu toxique est publié, des victimes le voient, certaines le signalent, et l'équipe de modération finit par l'examiner — souvent des heures ou des jours plus tard. Pendant tout ce temps, le contenu continue de faire du mal.</p>
            <p>L'intelligence artificielle de modération de Forsure inverse complètement cette logique. Elle analyse le contenu <strong className="text-foreground">avant sa publication</strong>. Si l'intelligence artificielle de modération détecte un risque, le contenu est bloqué instantanément. Le harcèlement, l'arnaque ou le discours de haine n'atteint jamais son destinataire. C'est la différence entre éteindre un incendie et empêcher qu'il ne se déclenche.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Protection renforcée des mineurs par l'intelligence artificielle de modération</h2>
            <p>L'intelligence artificielle de modération de Forsure accorde une attention particulière à la protection des mineurs. Pour les utilisateurs de moins de 16 ans, les seuils de détection sont abaissés et l'intelligence artificielle de modération surveille activement :</p>
            <ul className="space-y-2">
              <li>🛡️ <strong className="text-foreground">Tentatives de manipulation (grooming)</strong> — L'intelligence artificielle de modération détecte les schémas de manipulation des prédateurs</li>
              <li>🚫 <strong className="text-foreground">Messages suspects d'adultes inconnus</strong> — Bloqués automatiquement par l'intelligence artificielle de modération</li>
              <li>⚠️ <strong className="text-foreground">Contenus inappropriés pour les jeunes</strong> — Filtrés par l'intelligence artificielle de modération</li>
              <li>📢 <strong className="text-foreground">Alertes aux parents</strong> — L'intelligence artificielle de modération notifie les parents en cas de danger</li>
            </ul>
            <p>Cette <Link to="/protection-donnees" className="text-primary hover:underline">protection renforcée des données et des utilisateurs</Link> fait de Forsure l'un des réseaux sociaux les plus sûrs pour les jeunes.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Liberté d'expression et intelligence artificielle de modération</h2>
            <p>L'intelligence artificielle de modération de Forsure ne censure pas les opinions. Elle cible uniquement les comportements objectivement nuisibles : le harcèlement, les menaces, les discours de haine, les arnaques et les contenus illégaux. Les débats passionnés, les critiques constructives, les opinions divergentes et les discussions animées restent les bienvenus sur Forsure.</p>
            <p>L'objectif de l'intelligence artificielle de modération est de créer un espace de discussion libre mais respectueux — un endroit où vous pouvez vous exprimer sans crainte de harcèlement ou de manipulation.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Une intelligence artificielle de modération qui évolue en permanence</h2>
            <p>L'intelligence artificielle de modération de Forsure n'est pas un système figé. Elle apprend en continu grâce aux retours des utilisateurs et aux décisions des modérateurs humains. Chaque signalement, chaque contestation, chaque nouvelle forme de harcèlement enrichit la base de connaissances de l'intelligence artificielle de modération et améliore sa capacité à protéger la communauté.</p>
            <p>Découvrez également notre <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée de bout en bout</Link> pour des conversations privées et notre <Link to="/reseau-social-securise" className="text-primary hover:underline">réseau social sécurisé</Link> pour une protection complète de votre compte.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Rejoindre un réseau social protégé par l'IA</Button></Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 md:py-24 bg-muted/20" itemScope itemType="https://schema.org/FAQPage">
        <div className="max-w-3xl mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-center mb-10">Questions fréquentes sur l'intelligence artificielle de modération</h2>
          <div className="space-y-3">
            {faqs.map(f => <FAQItem key={f.q} q={f.q} a={f.a} />)}
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
