import { Link } from 'react-router-dom';
import { Users, ShieldCheck, Baby, MessageCircleOff, AlertOctagon, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SEOPageLayout } from '@/components/seo/SEOPageLayout';

const measures = [
  { icon: Baby, title: 'Protection renforcée des mineurs', desc: 'Les utilisateurs de moins de 16 ans bénéficient de protections supplémentaires : messages d\'inconnus bloqués, détection de manipulation, seuils de modération abaissés.' },
  { icon: MessageCircleOff, title: 'Messages d\'inconnus bloqués', desc: 'Par défaut, les mineurs ne peuvent recevoir de messages que de leurs contacts approuvés. Les adultes inconnus ne peuvent pas les contacter.' },
  { icon: AlertOctagon, title: 'Détection de manipulation', desc: 'L\'IA analyse les conversations pour détecter les tentatives de manipulation : questions personnelles suspectes, tentatives d\'isolement, demandes inappropriées.' },
  { icon: ShieldCheck, title: 'Contrôle parental intégré', desc: 'Les parents peuvent superviser l\'activité de leur enfant, limiter le temps d\'écran et contrôler les contacts autorisés via un tableau de bord dédié.' },
  { icon: Eye, title: 'Zéro tracking publicitaire', desc: 'Aucune donnée personnelle n\'est collectée à des fins publicitaires. Vos informations ne sont jamais vendues ni partagées avec des tiers.' },
  { icon: Users, title: 'Vérification d\'âge automatique', desc: 'Forsure vérifie l\'âge des utilisateurs à l\'inscription et adapte automatiquement les protections en fonction de leur tranche d\'âge.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Protection des données et des utilisateurs — Forsure',
  description: 'Forsure protège vos données personnelles et tous ses utilisateurs, en particulier les mineurs, avec contrôle parental et IA de détection.',
  url: 'https://forsure.fans/protection-donnees',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOProtection() {
  return (
    <SEOPageLayout
      title="Protection des données personnelles et des utilisateurs — Réseau social sûr"
      description="Forsure protège vos données personnelles et tous ses utilisateurs. Zéro tracking, contrôle parental intégré, détection de manipulation par IA. Un réseau social vraiment sûr."
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Users className="w-4 h-4" /> Protection des données
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">Vos données personnelles méritent une vraie protection</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Forsure met en place des mesures concrètes pour que chaque membre — en particulier les plus jeunes — soit en sécurité et que vos données restent les vôtres.</p>
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
            <h2 className="text-2xl font-bold text-foreground">Pourquoi la protection des données est essentielle</h2>
            <p>Les réseaux sociaux traditionnels collectent massivement vos données personnelles : localisation, historique de navigation, contacts, habitudes de consommation. Ces données sont revendues à des annonceurs qui vous ciblent avec de la publicité personnalisée. Forsure refuse ce modèle. Nous ne collectons que les données strictement nécessaires au fonctionnement du service, et nous ne les partageons avec personne.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Protection renforcée pour les mineurs</h2>
            <p>Les réseaux sociaux représentent un risque réel pour les jeunes utilisateurs : cyberharcèlement, prédateurs en ligne, exposition à des contenus inappropriés. Forsure a été conçu avec la protection des mineurs comme pilier fondamental. Les messages d'inconnus sont bloqués par défaut, et notre <Link to="/ia-moderation" className="text-primary hover:underline">intelligence artificielle de modération</Link> détecte les comportements suspects en temps réel.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Une approche proactive, pas réactive</h2>
            <p>Plutôt que d'attendre qu'un incident se produise, Forsure anticipe les dangers. L'IA analyse les interactions en temps réel et intervient automatiquement dès qu'un comportement à risque est détecté, souvent avant même que l'utilisateur ne s'en rende compte. Cette approche proactive est bien plus efficace que le système de signalement classique.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Le contrôle entre les mains des parents</h2>
            <p>Les parents disposent d'un tableau de bord complet pour superviser l'activité de leur enfant : temps d'écran, contacts autorisés, alertes de sécurité. Tout est conçu pour offrir la tranquillité d'esprit sans empiéter sur l'autonomie de l'enfant.</p>

            <p className="mt-6">Découvrez également notre <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée</Link> et notre <Link to="/reseau-social-securise" className="text-primary hover:underline">système de sécurité avancé</Link> pour une protection complète.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Créer un compte protégé</Button></Link>
            </div>
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
