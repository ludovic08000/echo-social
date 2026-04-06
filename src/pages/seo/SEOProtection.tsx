import { Link } from 'react-router-dom';
import { Users, ShieldCheck, Baby, MessageCircleOff, AlertOctagon, Eye, ChevronDown } from 'lucide-react';
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

const measures = [
  { icon: Baby, title: 'Protection renforcée des mineurs', desc: 'Les utilisateurs de moins de 16 ans bénéficient de protections supplémentaires pour la protection des données : messages d\'inconnus bloqués, détection de manipulation, seuils de modération abaissés.' },
  { icon: MessageCircleOff, title: 'Messages d\'inconnus bloqués', desc: 'Par défaut, les mineurs ne reçoivent de messages que de leurs contacts approuvés. La protection des données personnelles des jeunes est une priorité absolue.' },
  { icon: AlertOctagon, title: 'Détection de manipulation', desc: 'Notre IA analyse les conversations pour détecter les tentatives de manipulation et les comportements prédateurs. La protection des données et de la sécurité des mineurs est automatique.' },
  { icon: ShieldCheck, title: 'Contrôle parental intégré', desc: 'Les parents disposent d\'un tableau de bord complet pour superviser l\'activité de leur enfant et renforcer la protection des données de toute la famille.' },
  { icon: Eye, title: 'Zéro tracking publicitaire', desc: 'Aucune donnée personnelle n\'est collectée pour la publicité. La protection des données sur Forsure signifie que vos informations ne sont jamais vendues ni partagées.' },
  { icon: Users, title: 'Vérification d\'âge automatique', desc: 'Forsure vérifie l\'âge des utilisateurs à l\'inscription et adapte la protection des données en fonction de la tranche d\'âge.' },
];

const faqs = [
  { q: 'Comment Forsure assure-t-il la protection des données personnelles ?', a: 'Forsure ne collecte que les données strictement nécessaires au fonctionnement du service. Vos informations personnelles sont chiffrées et ne sont jamais vendues, partagées ou utilisées à des fins publicitaires. La protection des données est au cœur de notre architecture.' },
  { q: 'Mes données sont-elles vendues à des annonceurs ?', a: 'Non, jamais. Contrairement à Facebook, Instagram ou TikTok, Forsure ne vend aucune donnée personnelle. La protection des données de nos utilisateurs est un engagement fondamental — nous ne monétisons pas vos informations.' },
  { q: 'Comment fonctionne la protection des données pour les mineurs ?', a: 'Les utilisateurs de moins de 16 ans bénéficient de protections supplémentaires : messages d\'inconnus bloqués par défaut, détection automatique de manipulation, contrôle parental intégré. La protection des données des mineurs est renforcée à tous les niveaux.' },
  { q: 'Que se passe-t-il avec mes données si je supprime mon compte ?', a: 'Quand vous supprimez votre compte Forsure, toutes vos données personnelles sont effacées de nos serveurs dans un délai de 30 jours. La protection des données inclut le droit à l\'oubli complet.' },
  { q: 'Forsure est-il conforme au RGPD ?', a: 'Oui, Forsure est entièrement conforme au Règlement Général sur la Protection des Données (RGPD) européen. La protection des données personnelles est intégrée dès la conception de chaque fonctionnalité.' },
  { q: 'Les parents peuvent-ils contrôler l\'activité de leur enfant ?', a: 'Oui, le contrôle parental de Forsure permet aux parents de superviser le temps d\'écran, les contacts autorisés et de recevoir des alertes de sécurité. La protection des données et la sécurité des enfants sont notre priorité.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Protection des données personnelles — Forsure',
  description: 'Forsure assure la protection des données personnelles de tous ses utilisateurs. Zéro tracking, contrôle parental intégré, conformité RGPD.',
  url: 'https://forsure.fans/protection-donnees',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOProtection() {
  return (
    <SEOPageLayout
      title="Protection des données personnelles — Réseau social respectueux de la vie privée"
      description="Forsure assure la protection des données personnelles de tous ses utilisateurs. Zéro tracking publicitaire, contrôle parental intégré, conformité RGPD. Vos données restent les vôtres."
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Users className="w-4 h-4" /> Protection des données
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">La protection des données personnelles que vous méritez</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Sur Forsure, la protection des données n'est pas une option payante. C'est un droit fondamental, garanti pour chaque utilisateur dès l'inscription.</p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
            {measures.map(m => (
              <div key={m.title} className="bg-card border border-border/50 rounded-2xl p-6">
                <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4"><m.icon className="w-5 h-5 text-primary" /></div>
                <h3 className="font-semibold text-foreground mb-2">{m.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{m.desc}</p>
              </div>
            ))}
          </div>

          <div className="max-w-3xl mx-auto space-y-6 text-muted-foreground leading-relaxed">
            <h2 className="text-2xl font-bold text-foreground">Pourquoi la protection des données est cruciale sur les réseaux sociaux</h2>
            <p>Les réseaux sociaux traditionnels ont bâti leur empire sur l'exploitation de vos données personnelles. Facebook collecte plus de 98 catégories de données sur chaque utilisateur. Instagram analyse vos photos pour cibler la publicité. TikTok enregistre vos habitudes de visionnage dans les moindres détails. Toutes ces données sont revendues à des annonceurs qui vous ciblent avec une précision inquiétante.</p>
            <p>La protection des données personnelles sur Forsure repose sur un principe simple : nous ne collectons que le strict minimum nécessaire au fonctionnement du service, et nous ne partageons rien avec personne. Pas d'annonceurs, pas de tiers, pas de partenaires commerciaux. Vos données restent les vôtres — point final.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Ce que Forsure ne fait jamais avec vos données</h2>
            <p>Pour bien comprendre ce que signifie la protection des données sur Forsure, voici ce que nous ne faisons jamais :</p>
            <ul className="space-y-2">
              <li>❌ <strong className="text-foreground">Pas de publicité ciblée</strong> — Aucune donnée n'est utilisée pour vous montrer des publicités</li>
              <li>❌ <strong className="text-foreground">Pas de revente de données</strong> — Vos informations ne sont jamais vendues à des tiers</li>
              <li>❌ <strong className="text-foreground">Pas de cookies de suivi</strong> — Aucun tracker ne suit votre activité en ligne</li>
              <li>❌ <strong className="text-foreground">Pas d'analyse comportementale</strong> — Vos habitudes ne sont pas étudiées pour vous manipuler</li>
              <li>❌ <strong className="text-foreground">Pas de partage avec des gouvernements</strong> — Sauf obligation légale stricte avec contrôle judiciaire</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Protection des données renforcée pour les enfants et adolescents</h2>
            <p>La protection des données des mineurs est une responsabilité que Forsure prend très au sérieux. Les réseaux sociaux représentent un risque réel pour les jeunes utilisateurs : cyberharcèlement, prédateurs en ligne, exposition à des contenus inappropriés, collecte de données sans consentement éclairé.</p>
            <p>Sur Forsure, les utilisateurs de moins de 16 ans bénéficient de mesures de protection des données supplémentaires :</p>
            <ul className="space-y-2">
              <li>🛡️ <strong className="text-foreground">Messages d'inconnus bloqués</strong> — Seuls les contacts approuvés peuvent envoyer des messages</li>
              <li>🤖 <strong className="text-foreground">Détection de manipulation</strong> — Notre <Link to="/ia-moderation" className="text-primary hover:underline">intelligence artificielle de modération</Link> détecte les tentatives de manipulation</li>
              <li>👨‍👩‍👧 <strong className="text-foreground">Contrôle parental complet</strong> — Les parents supervisent le temps d'écran et les contacts</li>
              <li>📊 <strong className="text-foreground">Alertes de sécurité</strong> — Notification immédiate en cas de comportement suspect</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Conformité RGPD et droit à l'oubli</h2>
            <p>Forsure est entièrement conforme au Règlement Général sur la Protection des Données (RGPD) de l'Union Européenne. La protection des données est intégrée dès la conception de chaque fonctionnalité (privacy by design). Vous disposez de tous les droits prévus par la loi :</p>
            <ul className="space-y-2">
              <li>✅ <strong className="text-foreground">Droit d'accès</strong> — Consultez toutes les données que nous détenons sur vous</li>
              <li>✅ <strong className="text-foreground">Droit de rectification</strong> — Corrigez vos informations à tout moment</li>
              <li>✅ <strong className="text-foreground">Droit à l'effacement</strong> — Supprimez votre compte et toutes vos données définitivement</li>
              <li>✅ <strong className="text-foreground">Droit à la portabilité</strong> — Exportez vos données dans un format standard</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Le contrôle entre vos mains</h2>
            <p>La protection des données sur Forsure ne se limite pas à des promesses. Chaque utilisateur dispose d'un panneau de contrôle complet pour gérer ses paramètres de confidentialité : visibilité du profil, qui peut vous contacter, quelles informations sont publiques. Vous gardez le contrôle total sur votre présence en ligne.</p>
            <p>Découvrez également notre <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée de bout en bout</Link> et notre <Link to="/reseau-social-securise" className="text-primary hover:underline">réseau social sécurisé</Link> pour une protection complète de votre vie numérique.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Protéger mes données — inscription gratuite</Button></Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 md:py-24 bg-muted/20" itemScope itemType="https://schema.org/FAQPage">
        <div className="max-w-3xl mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-center mb-10">Questions fréquentes sur la protection des données</h2>
          <div className="space-y-3">
            {faqs.map(f => <FAQItem key={f.q} q={f.q} a={f.a} />)}
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
