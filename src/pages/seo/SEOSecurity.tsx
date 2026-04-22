import { Link } from 'react-router-dom';
import { Shield, Wifi, Bug, Server, Lock, AlertTriangle, ChevronDown, CheckCircle } from 'lucide-react';
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
  { icon: Bug, title: 'Protection contre le piratage', desc: 'Notre réseau social sécurisé détecte et bloque automatiquement les tentatives de piratage de votre compte. Vos mots de passe et données personnelles sont protégés en permanence par des systèmes de chiffrement avancés.' },
  { icon: Wifi, title: 'Réseau toujours disponible', desc: 'Le réseau social sécurisé Forsure reste accessible même en cas d\'attaque massive. Notre bouclier de protection intelligent filtre les connexions malveillantes et garantit un accès continu.' },
  { icon: Server, title: 'Connexions vérifiées uniquement', desc: 'Seuls les serveurs de confiance peuvent communiquer avec votre compte sur notre réseau social sécurisé. Aucun service tiers non approuvé ne peut accéder à vos informations.' },
  { icon: Lock, title: 'Sessions protégées en continu', desc: 'Chaque session sur notre réseau social sécurisé est protégée par un jeton d\'authentification unique et renouvelé automatiquement, empêchant toute prise de contrôle.' },
  { icon: AlertTriangle, title: 'Détection des comportements suspects', desc: 'Le réseau social sécurisé Forsure identifie les comportements anormaux — faux comptes, activité suspecte, tentatives de fraude — et les bloque immédiatement.' },
  { icon: Shield, title: 'Surveillance continue 24h/24', desc: 'Notre équipe de sécurité surveille le réseau social sécurisé en permanence. Toute anomalie est détectée en quelques secondes et traitée immédiatement.' },
];

const faqs = [
  { q: 'Comment le réseau social sécurisé Forsure protège-t-il mon compte contre le piratage ?', a: 'Le réseau social sécurisé Forsure utilise plusieurs couches de protection pour sécuriser votre compte. Chaque connexion est vérifiée, les tentatives d\'accès non autorisé sont bloquées automatiquement, et vous êtes alerté immédiatement en cas d\'activité suspecte. Les connexions depuis des appareils ou localisations inhabituels sont automatiquement bloquées.' },
  { q: 'Mes données personnelles sont-elles en sécurité sur le réseau social sécurisé Forsure ?', a: 'Absolument. Le réseau social sécurisé Forsure ne collecte que les données strictement nécessaires au fonctionnement du service. Vos informations personnelles sont chiffrées et ne sont jamais vendues, partagées ou utilisées à des fins publicitaires.' },
  { q: 'Que se passe-t-il si quelqu\'un essaie de pirater mon compte sur le réseau social sécurisé ?', a: 'Le réseau social sécurisé Forsure détecte automatiquement les tentatives de piratage et bloque l\'accès. Vous recevez une notification immédiate et pouvez sécuriser votre compte en un clic. Les tentatives répétées entraînent un blocage définitif de l\'attaquant.' },
  { q: 'Le réseau social sécurisé Forsure est-il plus sûr que Facebook ou Instagram ?', a: 'Le réseau social sécurisé Forsure a été conçu dès le départ avec la sécurité comme fondation. Contrairement à Facebook ou Instagram, nous ne collectons pas vos données pour les revendre. Notre architecture de sécurité est comparable à celle des institutions financières.' },
  { q: 'Comment le réseau social sécurisé détecte-t-il les faux comptes ?', a: 'Le réseau social sécurisé Forsure utilise un système d\'empreinte numérique avancé qui identifie les créations de faux comptes et les bloque automatiquement. Les comptes suspects sont vérifiés par notre équipe avant de pouvoir interagir.' },
  { q: 'Le réseau social sécurisé fonctionne-t-il sur mobile ?', a: 'Oui, toutes les protections du réseau social sécurisé Forsure sont actives sur tous les appareils — smartphone, tablette, ordinateur. Que vous utilisiez l\'application ou le navigateur, votre compte bénéficie du même niveau de sécurité.' },
  { q: 'Le réseau social sécurisé Forsure protège-t-il aussi mes photos et vidéos ?', a: 'Oui, le réseau social sécurisé Forsure protège tous vos contenus — photos, vidéos, messages, documents. Chaque fichier est sécurisé par notre système de protection multicouche pour empêcher tout accès non autorisé.' },
  { q: 'Pourquoi choisir un réseau social sécurisé plutôt qu\'un réseau classique ?', a: 'Un réseau social sécurisé comme Forsure vous garantit que vos données ne seront jamais vendues, que votre compte est protégé contre le piratage, et que vos conversations restent privées. C\'est la tranquillité d\'esprit numérique.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Réseau social sécurisé — Protection contre le piratage et les cyberattaques — Forsure',
  description: 'Forsure est le réseau social sécurisé français qui protège votre compte contre le piratage, les cyberattaques et le vol de données personnelles. Gratuit et sans publicité.',
  url: 'https://forsure.fans/reseau-social-securise',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOSecurity() {
  return (
    <SEOPageLayout
      title="Réseau social sécurisé — Sans tracking, données privées et protégées"
      description="Forsure est le réseau social sécurisé sans tracking : vos données privées restent les vôtres. Protection contre piratage, intrusions et cyberattaques en temps réel."
      url="https://forsure.fans/reseau-social-securise"
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Shield className="w-4 h-4" /> Réseau social sécurisé
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">Forsure : le réseau social sécurisé qui protège vraiment votre compte</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Sur le réseau social sécurisé Forsure, votre sécurité n'est pas une option. Des protections avancées sont actives 24h/24 pour que vous puissiez publier, discuter et partager en toute tranquillité.</p>
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
            <h2 className="text-2xl font-bold text-foreground">Pourquoi choisir un réseau social sécurisé en 2025 ?</h2>
            <p>En 2025, la sécurité en ligne n'est plus une option — c'est une nécessité absolue. Chaque jour, des milliers de comptes sont piratés sur les réseaux sociaux traditionnels. Facebook a exposé les données de 533 millions d'utilisateurs en 2021. Instagram subit régulièrement des fuites de données massives. TikTok est régulièrement épinglé pour ses pratiques de collecte de données intrusives.</p>
            <p>Le réseau social sécurisé Forsure a été créé pour répondre à ce besoin fondamental : offrir un espace numérique où vous pouvez vous exprimer librement sans craindre pour la sécurité de vos données personnelles. Contrairement aux réseaux sociaux classiques qui traitent la sécurité comme un ajout, le réseau social sécurisé Forsure a été construit avec la protection comme fondation même de son architecture.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Les chiffres qui montrent l'urgence d'un réseau social sécurisé</h3>
            <p>Pour comprendre pourquoi un réseau social sécurisé est devenu indispensable, regardons les faits :</p>
            <ul className="space-y-2">
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">2,6 milliards</strong> de données personnelles exposées dans le monde en 2023</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">1 personne sur 3</strong> a déjà vu son compte piraté sur un réseau social</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">80 %</strong> des piratages exploitent des failles de sécurité basiques</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Facebook, Instagram, TikTok</strong> vendent vos données à des centaines d'annonceurs</li>
            </ul>
            <p>Le réseau social sécurisé Forsure élimine ces risques à la source en ne collectant aucune donnée inutile et en protégeant chaque interaction par des technologies de pointe.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Comment le réseau social sécurisé Forsure protège votre compte</h2>

            <h3 className="text-xl font-bold text-foreground mt-8">Protection contre le piratage de mot de passe</h3>
            <p>Le piratage de mot de passe est la menace la plus courante sur les réseaux sociaux. Les pirates utilisent des listes de mots de passe volés, des attaques par force brute ou des techniques de phishing pour accéder à votre compte. Le réseau social sécurisé Forsure neutralise ces attaques grâce à plusieurs mécanismes complémentaires.</p>
            <p>Premièrement, votre mot de passe n'est jamais stocké en clair sur nos serveurs. Il est transformé par un algorithme de hachage irréversible, ce qui signifie que même en cas d'accès non autorisé à nos bases de données, votre mot de passe resterait illisible et inexploitable. Deuxièmement, le réseau social sécurisé détecte et bloque automatiquement les tentatives de connexion suspectes — trop de tentatives échouées, localisation inhabituelle, appareil inconnu.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Protection contre les faux sites de connexion (phishing)</h3>
            <p>Le phishing — ces faux sites qui imitent la page de connexion d'un réseau social pour voler vos identifiants — est une technique de piratage redoutablement efficace. Le réseau social sécurisé Forsure intègre des protections spécifiques contre cette menace : les sessions sont liées à votre appareil, et toute tentative de connexion depuis un environnement non vérifié est automatiquement bloquée et signalée.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Protection contre la prise de contrôle de session</h3>
            <p>Même si vous êtes déjà connecté, un pirate peut tenter de "voler" votre session en interceptant votre jeton de connexion. Le réseau social sécurisé Forsure renouvelle automatiquement ces jetons à intervalles réguliers et les lie à votre appareil spécifique. Si un jeton est utilisé depuis un appareil différent, la session est immédiatement invalidée et vous êtes alerté.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Protection contre les attaques à grande échelle</h2>
            <p>Les réseaux sociaux sont des cibles privilégiées pour les cyberattaques à grande échelle. Le réseau social sécurisé Forsure est équipé d'un bouclier intelligent capable de détecter et de neutraliser ces attaques en temps réel, sans impact sur votre expérience utilisateur.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Résistance aux attaques par surcharge</h3>
            <p>Les attaques par surcharge visent à rendre un service inaccessible en l'inondant de requêtes malveillantes. Le réseau social sécurisé Forsure filtre automatiquement le trafic suspect et redirige les requêtes légitimes, garantissant que la plateforme reste accessible même pendant une attaque massive.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Blocage des injections de code malveillant</h3>
            <p>Les injections de code malveillant sont des attaques sophistiquées où un pirate tente d'insérer du code dangereux dans les pages du réseau social pour voler des informations ou prendre le contrôle de comptes. Le réseau social sécurisé Forsure filtre et neutralise automatiquement ces tentatives grâce à des règles de sécurité strictes appliquées à chaque contenu.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Détection des faux comptes et des comportements frauduleux</h2>
            <p>Les faux comptes sont un fléau sur les réseaux sociaux traditionnels. Ils sont utilisés pour le harcèlement, les arnaques, la manipulation d'opinion et l'usurpation d'identité. Le réseau social sécurisé Forsure utilise un système d'empreinte numérique avancé pour détecter automatiquement les créations de faux comptes et les neutraliser avant qu'ils ne puissent nuire.</p>
            <p>Les comportements suspects — création de multiples comptes depuis le même appareil, envoi massif de messages identiques, tentatives de contournement des règles de modération — sont identifiés par notre intelligence artificielle et traités en temps réel. Cette vigilance permanente fait du réseau social sécurisé Forsure un environnement de confiance pour tous ses utilisateurs.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Vos données ne sont jamais vendues ni partagées</h2>
            <p>C'est la différence fondamentale entre le réseau social sécurisé Forsure et les plateformes traditionnelles. Nous ne collectons pas vos données personnelles pour les revendre à des annonceurs. Nous ne partageons rien avec des tiers. Nous ne traçons pas votre activité en ligne. Sur le réseau social sécurisé Forsure, vos données restent les vôtres — c'est notre engagement le plus fondamental.</p>
            <p>Alors que Facebook tire plus de 97 % de ses revenus de la vente de vos données aux annonceurs, le réseau social sécurisé Forsure repose sur un modèle économique respectueux : des abonnements créateur optionnels pour ceux qui souhaitent des fonctionnalités avancées, et zéro exploitation de vos données personnelles.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Un réseau social sécurisé complet, au-delà de la sécurité technique</h2>
            <p>Le réseau social sécurisé Forsure ne se limite pas aux protections techniques. Il intègre également :</p>
            <ul className="space-y-2">
              <li>🔒 Une <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée de bout en bout</Link> pour des conversations parfaitement privées</li>
              <li>🤖 Une <Link to="/ia-moderation" className="text-primary hover:underline">intelligence artificielle de modération</Link> qui bloque le harcèlement en temps réel</li>
              <li>🛡️ Une <Link to="/protection-donnees" className="text-primary hover:underline">protection des données personnelles</Link> conforme au RGPD</li>
              <li>📱 Un <Link to="/feed-intelligent" className="text-primary hover:underline">feed intelligent et éthique</Link> sans publicité ni manipulation</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Rejoindre le réseau social sécurisé Forsure</h2>
            <p>Le réseau social sécurisé Forsure est gratuit, sans publicité et accessible à tous. L'inscription prend moins de 30 secondes et ne nécessite aucune carte bancaire. Dès votre premier accès, votre compte est protégé par l'ensemble de nos mesures de sécurité — automatiquement, sans configuration de votre part. Rejoignez des milliers d'utilisateurs qui ont choisi un réseau social sécurisé pour protéger leur vie numérique.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Rejoindre le réseau social sécurisé</Button></Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 md:py-24 bg-muted/20" itemScope itemType="https://schema.org/FAQPage">
        <div className="max-w-3xl mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-center mb-10">Questions fréquentes sur le réseau social sécurisé</h2>
          <div className="space-y-3">
            {faqs.map(f => <FAQItem key={f.q} q={f.q} a={f.a} />)}
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
