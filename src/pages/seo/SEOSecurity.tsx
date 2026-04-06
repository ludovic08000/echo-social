import { Link } from 'react-router-dom';
import { Shield, Wifi, Bug, Server, Lock, AlertTriangle, ChevronDown } from 'lucide-react';
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

const protections = [
  { icon: Bug, title: 'Protection contre le piratage', desc: 'Les tentatives de piratage de votre compte sont automatiquement détectées et bloquées. Vos mots de passe et données personnelles sont protégés en permanence.' },
  { icon: Wifi, title: 'Réseau toujours disponible', desc: 'Notre réseau social sécurisé reste accessible même en cas d\'attaque massive. Notre bouclier de protection intelligent filtre les connexions malveillantes en temps réel.' },
  { icon: Server, title: 'Connexions vérifiées', desc: 'Seuls les serveurs de confiance peuvent communiquer avec votre compte. Aucun service tiers non approuvé ne peut accéder à vos informations personnelles.' },
  { icon: Lock, title: 'Sessions protégées', desc: 'Chaque fois que vous vous connectez, votre session est protégée par un système de sécurité avancé qui empêche quiconque de prendre le contrôle de votre compte.' },
  { icon: AlertTriangle, title: 'Détection des comportements suspects', desc: 'Notre système identifie les comportements anormaux — création de faux comptes, activité suspecte, tentatives de fraude — et les bloque immédiatement.' },
  { icon: Shield, title: 'Surveillance continue 24h/24', desc: 'Notre équipe de sécurité surveille le réseau social sécurisé en permanence. Toute anomalie est traitée en quelques secondes pour garantir votre tranquillité.' },
];

const faqs = [
  { q: 'Comment Forsure protège-t-il mon compte contre le piratage ?', a: 'Forsure utilise plusieurs couches de protection pour sécuriser votre compte. Chaque connexion est vérifiée, les tentatives d\'accès non autorisé sont bloquées automatiquement, et vous êtes alerté immédiatement en cas d\'activité suspecte. Notre réseau social sécurisé détecte les connexions depuis des appareils ou localisations inhabituels.' },
  { q: 'Mes données personnelles sont-elles en sécurité sur Forsure ?', a: 'Absolument. Forsure ne collecte que les données strictement nécessaires au fonctionnement du service. Vos informations personnelles sont chiffrées et ne sont jamais vendues, partagées ou utilisées à des fins publicitaires. C\'est ce qui fait de Forsure un réseau social sécurisé.' },
  { q: 'Que se passe-t-il si quelqu\'un essaie de pirater mon compte ?', a: 'Notre système de sécurité détecte automatiquement les tentatives de piratage et bloque l\'accès. Vous recevez une notification immédiate et pouvez sécuriser votre compte en un clic. Les tentatives répétées entraînent un blocage définitif de l\'attaquant.' },
  { q: 'Forsure est-il plus sécurisé que Facebook ou Instagram ?', a: 'Forsure a été conçu dès le départ comme un réseau social sécurisé. Contrairement à Facebook ou Instagram, nous ne collectons pas vos données pour les revendre. Notre architecture de sécurité est comparable à celle des banques et des services gouvernementaux.' },
  { q: 'Comment Forsure protège-t-il contre les faux comptes ?', a: 'Notre système d\'empreinte numérique identifie les créations de faux comptes et les bloque automatiquement. Les comptes suspects sont signalés et vérifiés par notre équipe avant de pouvoir interagir avec d\'autres utilisateurs du réseau social sécurisé.' },
  { q: 'La sécurité de Forsure fonctionne-t-elle sur mobile ?', a: 'Oui, toutes les protections de notre réseau social sécurisé sont actives sur tous les appareils — smartphone, tablette, ordinateur. Que vous utilisiez l\'application ou le navigateur, votre compte bénéficie du même niveau de sécurité.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Réseau social sécurisé — Protection contre le piratage — Forsure',
  description: 'Forsure est un réseau social sécurisé qui protège votre compte contre le piratage, les cyberattaques et le vol de données personnelles.',
  url: 'https://forsure.fans/reseau-social-securise',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOSecurity() {
  return (
    <SEOPageLayout
      title="Réseau social sécurisé — Protection contre piratage et cyberattaques"
      description="Forsure est un réseau social sécurisé qui protège votre compte contre le piratage, les cyberattaques et le vol de données. Sécurité de niveau professionnel, gratuite pour tous."
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Shield className="w-4 h-4" /> Réseau social sécurisé
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">Forsure : le réseau social sécurisé qui protège vraiment votre compte</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Sur Forsure, votre sécurité n'est pas une option. Notre réseau social sécurisé intègre des protections avancées pour que vous puissiez publier, discuter et partager en toute tranquillité.</p>
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
            <h2 className="text-2xl font-bold text-foreground">Pourquoi Forsure est un réseau social sécurisé ?</h2>
            <p>La plupart des réseaux sociaux — Facebook, Instagram, TikTok — ont été conçus pour collecter un maximum de données personnelles et les monétiser via la publicité. La sécurité arrive souvent en second plan, avec des failles découvertes après des violations massives de données. Facebook a exposé les données de 533 millions d'utilisateurs en 2021. Instagram a été victime de fuites de données à répétition.</p>
            <p>Forsure adopte l'approche inverse. Notre réseau social sécurisé a été construit dès le départ avec la sécurité comme fondation, pas comme un ajout après coup. Chaque ligne de code, chaque fonctionnalité, chaque interaction est conçue pour protéger vos données personnelles et votre vie privée.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Comment Forsure protège votre compte contre le piratage</h2>
            <p>Le piratage de compte est l'une des menaces les plus courantes sur les réseaux sociaux. Des millions de comptes sont compromis chaque année par des techniques de vol de mot de passe, de faux sites de connexion ou de prise de contrôle de session. Sur notre réseau social sécurisé, ces attaques sont neutralisées avant de pouvoir aboutir.</p>
            <p>Forsure détecte automatiquement les connexions inhabituelles — nouvelle localisation géographique, nouvel appareil, comportement anormal. En cas de doute, nous bloquons l'accès et vous alertons immédiatement. Vous pouvez alors vérifier s'il s'agit bien de vous ou sécuriser votre compte en un clic.</p>
            <p>Vos données de connexion sont protégées par des systèmes de chiffrement avancés. Même si un pirate réussissait à accéder à nos serveurs — ce qui est extrêmement improbable — vos mots de passe resteraient illisibles et inexploitables.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Protection contre les attaques à grande échelle</h2>
            <p>Les cyberattaques ne visent pas uniquement les comptes individuels. Les réseaux sociaux sont régulièrement la cible d'attaques massives visant à rendre le service inaccessible ou à exploiter des failles de sécurité. Notre réseau social sécurisé est équipé d'un bouclier intelligent qui détecte et neutralise ces attaques en temps réel.</p>
            <p>Que ce soit une tentative de surcharge de nos serveurs, une injection de code malveillant dans une page, ou une tentative d'accès frauduleux à des données, notre système de défense multicouche bloque la menace en quelques millisecondes — bien avant qu'elle ne puisse affecter votre expérience.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Détection des faux comptes et des comportements frauduleux</h2>
            <p>Les faux comptes sont un fléau sur les réseaux sociaux traditionnels. Ils sont utilisés pour le harcèlement, les arnaques, la manipulation d'opinion et l'usurpation d'identité. Forsure utilise un système d'empreinte numérique avancé pour détecter automatiquement les créations de faux comptes.</p>
            <p>Les comportements suspects — création de multiples comptes, envoi massif de messages, activité anormale — sont identifiés et bloqués avant de pouvoir causer du tort aux utilisateurs de notre réseau social sécurisé.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Vos données ne sont jamais vendues ni partagées</h2>
            <p>C'est la différence fondamentale entre Forsure et les autres réseaux sociaux. Nous ne collectons pas vos données personnelles pour les revendre à des annonceurs. Nous ne partageons rien avec des tiers. Nous ne traçons pas votre activité en ligne. Sur notre réseau social sécurisé, vos données restent les vôtres — point final.</p>
            <p>Découvrez également comment notre <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée de bout en bout</Link> protège vos conversations privées, et comment notre <Link to="/ia-moderation" className="text-primary hover:underline">intelligence artificielle de modération</Link> assure un environnement sain pour tous.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Un réseau social sécurisé accessible à tous</h2>
            <p>Vous n'avez pas besoin d'être un expert en informatique pour bénéficier de cette protection. Toutes les mesures de sécurité de Forsure sont actives par défaut, sans aucune configuration de votre part. Dès votre inscription, votre compte est protégé par les mêmes technologies utilisées par les grandes institutions financières et les services gouvernementaux.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Rejoindre le réseau social sécurisé</Button></Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 md:py-24 bg-muted/20" itemScope itemType="https://schema.org/FAQPage">
        <div className="max-w-3xl mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-center mb-10">Questions fréquentes sur la sécurité de Forsure</h2>
          <div className="space-y-3">
            {faqs.map(f => <FAQItem key={f.q} q={f.q} a={f.a} />)}
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
