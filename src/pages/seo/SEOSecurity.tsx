import { Link } from 'react-router-dom';
import { Shield, Wifi, Bug, Server, Lock, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SEOPageLayout } from '@/components/seo/SEOPageLayout';

const protections = [
  { icon: Bug, title: 'Protection contre le piratage', desc: 'Les tentatives d\'injection de code malveillant (utilisées pour voler des mots de passe et des données) sont automatiquement détectées et bloquées avant d\'atteindre votre navigateur.' },
  { icon: Wifi, title: 'Bouclier anti-surcharge', desc: 'Notre système détecte et bloque les attaques par surcharge de serveur en temps réel, garantissant que Forsure reste accessible même en cas d\'attaque massive.' },
  { icon: Server, title: 'Connexions sécurisées uniquement', desc: 'Forsure n\'autorise les connexions qu\'avec des serveurs vérifiés. Aucun script externe ou service tiers non approuvé ne peut s\'exécuter dans l\'application.' },
  { icon: Lock, title: 'Sessions protégées', desc: 'Chaque session est protégée par un jeton d\'authentification unique et renouvelé. Les tentatives de détournement de session sont automatiquement invalidées.' },
  { icon: AlertTriangle, title: 'Détection de comptes suspects', desc: 'Notre système identifie les comportements anormaux — création de multi-comptes, activité suspecte, tentatives de contournement — et les bloque automatiquement.' },
  { icon: Shield, title: 'Surveillance continue 24/7', desc: 'Notre équipe de sécurité surveille la plateforme en permanence. Les anomalies sont détectées en quelques secondes et traitées immédiatement.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Réseau social sécurisé — Protection contre le piratage — Forsure',
  description: 'Forsure protège votre compte contre le piratage, les cyberattaques et le vol de données. Sécurité de niveau entreprise pour tous.',
  url: 'https://forsure.fans/reseau-social-securise',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOSecurity() {
  return (
    <SEOPageLayout
      title="Réseau social sécurisé — Protection contre piratage et cyberattaques"
      description="Forsure protège votre compte contre le piratage, les cyberattaques et le vol de données. Sécurité de niveau entreprise pour tous les utilisateurs, gratuitement."
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Shield className="w-4 h-4" /> Réseau social sécurisé
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">Un réseau social sécurisé contre toutes les menaces</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Forsure intègre des protections de niveau entreprise pour que vous puissiez utiliser le réseau social en toute tranquillité, sans craindre pour vos données.</p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
            {protections.map(p => (
              <div key={p.title} className="bg-card border border-border/50 rounded-2xl p-6">
                <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4"><p.icon className="w-5 h-5 text-primary" /></div>
                <h3 className="font-semibold text-foreground mb-2">{p.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{p.desc}</p>
              </div>
            ))}
          </div>

          <div className="max-w-3xl mx-auto space-y-6 text-muted-foreground leading-relaxed">
            <h2 className="text-2xl font-bold text-foreground">Une approche multi-niveaux de la sécurité</h2>
            <p>Contrairement à de nombreux réseaux sociaux qui se contentent d'un simple mot de passe pour protéger votre compte, Forsure déploie plusieurs couches de protection complémentaires. Chaque requête, chaque connexion, chaque interaction est vérifiée et validée en temps réel par notre bouclier de sécurité intelligent.</p>
            <p>Les tentatives de piratage de compte — qu'il s'agisse d'injections de code malveillant, d'accès frauduleux à votre session ou de surcharge intentionnelle de nos serveurs — sont toutes neutralisées automatiquement avant de pouvoir causer le moindre dégât.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Protection contre le piratage de compte</h2>
            <p>Forsure détecte automatiquement les connexions inhabituelles — nouvelle localisation, nouvel appareil, comportement anormal. En cas de doute, nous vous alertons immédiatement et bloquons l'accès suspect. Vos données d'authentification sont protégées par des standards de chiffrement avancés, avec des jetons de connexion sécurisés qui se renouvellent automatiquement.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Vos données ne sont jamais exposées</h2>
            <p>Contrairement aux réseaux sociaux qui ont subi des violations massives de données (Facebook : 533 millions de comptes exposés en 2021), Forsure minimise les données stockées et chiffre tout ce qui transite par nos serveurs. Même en cas d'intrusion, vos informations personnelles restent illisibles et inexploitables.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Un réseau social que vous pouvez utiliser en confiance</h2>
            <p>La sécurité ne devrait pas être un luxe réservé aux experts en informatique. Sur Forsure, toutes ces protections sont actives par défaut, sans aucune configuration de votre part. Vous pouvez publier, discuter et partager en toute sérénité. Découvrez aussi notre <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée de bout en bout</Link> et notre <Link to="/ia-moderation" className="text-primary hover:underline">système de modération par IA</Link>.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Rejoindre un réseau social sécurisé</Button></Link>
            </div>
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
