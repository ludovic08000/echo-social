import { Link } from 'react-router-dom';
import { Users, ShieldCheck, Baby, MessageCircleOff, AlertOctagon, Eye, ChevronDown, CheckCircle } from 'lucide-react';
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
  { icon: Baby, title: 'Protection des données des mineurs', desc: 'La protection des données des utilisateurs de moins de 16 ans est renforcée : messages d\'inconnus bloqués, détection de manipulation, seuils de modération abaissés.' },
  { icon: MessageCircleOff, title: 'Messages d\'inconnus bloqués', desc: 'La protection des données des mineurs inclut le blocage par défaut des messages provenant d\'adultes inconnus. Seuls les contacts approuvés peuvent communiquer.' },
  { icon: AlertOctagon, title: 'Détection de manipulation', desc: 'La protection des données est renforcée par une IA qui détecte les tentatives de manipulation et les comportements prédateurs en temps réel.' },
  { icon: ShieldCheck, title: 'Contrôle parental intégré', desc: 'La protection des données de votre famille est entre vos mains grâce à un tableau de bord parental complet pour superviser l\'activité de vos enfants.' },
  { icon: Eye, title: 'Zéro tracking publicitaire', desc: 'La protection des données sur Forsure signifie qu\'aucune donnée personnelle n\'est collectée pour la publicité. Vos informations ne sont jamais vendues.' },
  { icon: Users, title: 'Vérification d\'âge automatique', desc: 'La protection des données est adaptée automatiquement en fonction de l\'âge vérifié de chaque utilisateur lors de l\'inscription.' },
];

const faqs = [
  { q: 'Comment Forsure assure-t-il la protection des données personnelles ?', a: 'La protection des données sur Forsure repose sur un principe simple : nous ne collectons que le strict minimum nécessaire au fonctionnement du service. Vos informations personnelles sont chiffrées et ne sont jamais vendues, partagées ou utilisées à des fins publicitaires.' },
  { q: 'Mes données sont-elles vendues à des annonceurs ?', a: 'Non, jamais. La protection des données sur Forsure est un engagement fondamental. Contrairement à Facebook, Instagram ou TikTok, nous ne vendons aucune donnée personnelle et ne monétisons pas vos informations.' },
  { q: 'Comment fonctionne la protection des données pour les mineurs ?', a: 'La protection des données des mineurs est renforcée à tous les niveaux : messages d\'inconnus bloqués par défaut, détection automatique de manipulation, contrôle parental intégré, et filtrage des contenus inappropriés.' },
  { q: 'Que se passe-t-il avec mes données si je supprime mon compte ?', a: 'La protection des données inclut le droit à l\'oubli complet. Quand vous supprimez votre compte, toutes vos données personnelles sont effacées de nos serveurs dans un délai de 30 jours maximum.' },
  { q: 'Forsure est-il conforme au RGPD pour la protection des données ?', a: 'Oui, la protection des données sur Forsure est entièrement conforme au Règlement Général sur la Protection des Données (RGPD) européen. La protection des données est intégrée dès la conception de chaque fonctionnalité.' },
  { q: 'Les parents peuvent-ils renforcer la protection des données de leur enfant ?', a: 'Oui, le contrôle parental de Forsure permet de renforcer la protection des données et de la sécurité : supervision du temps d\'écran, gestion des contacts autorisés, et alertes de sécurité en temps réel.' },
  { q: 'Quelles données Forsure collecte-t-il exactement ?', a: 'La protection des données sur Forsure se traduit par une collecte minimale : votre email, votre nom d\'utilisateur, et les contenus que vous publiez volontairement. Aucune donnée de navigation, aucun cookie de suivi, aucune information de localisation.' },
  { q: 'La protection des données est-elle la même sur mobile et ordinateur ?', a: 'Oui, la protection des données sur Forsure est identique sur tous les appareils — smartphone, tablette, ordinateur. Que vous utilisiez l\'application ou le navigateur, vos données bénéficient du même niveau de protection.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Protection des données personnelles — Réseau social respectueux de la vie privée — Forsure',
  description: 'Forsure assure la protection des données personnelles de tous ses utilisateurs. Zéro tracking publicitaire, contrôle parental intégré, conformité RGPD.',
  url: 'https://forsure.fans/protection-donnees',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOProtection() {
  return (
    <SEOPageLayout
      title="Protection des données personnelles — Conformité RGPD et vie privée"
      description="Protection des données personnelles totale sur Forsure : conformité RGPD stricte, respect de la vie privée, zéro tracking publicitaire. Vos données restent les vôtres, toujours."
      url="https://forsure.fans/protection-donnees"
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Users className="w-4 h-4" /> Protection des données
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">La protection des données personnelles que vous méritez vraiment</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Sur Forsure, la protection des données n'est pas une option payante ou un argument marketing creux. C'est un droit fondamental, garanti pour chaque utilisateur.</p>
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
            <h2 className="text-2xl font-bold text-foreground">Pourquoi la protection des données est cruciale sur les réseaux sociaux en 2025</h2>
            <p>En 2025, la protection des données personnelles sur les réseaux sociaux est devenue un enjeu majeur de société. Les réseaux sociaux traditionnels ont bâti leur empire sur l'exploitation massive de vos données. Facebook collecte plus de 98 catégories de données sur chaque utilisateur. Instagram analyse vos photos, vos likes et vos habitudes de navigation pour cibler la publicité. TikTok enregistre vos comportements dans les moindres détails.</p>
            <p>La protection des données sur Forsure repose sur un principe fondamentalement différent : nous ne collectons que le strict minimum nécessaire au fonctionnement du service, et nous ne partageons rien avec personne. Pas d'annonceurs, pas de tiers, pas de partenaires commerciaux. La protection des données est la base même de notre philosophie.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Les chiffres alarmants de l'exploitation des données</h3>
            <p>Pour comprendre pourquoi la protection des données est si importante, regardons comment les réseaux sociaux traditionnels exploitent vos informations :</p>
            <ul className="space-y-2">
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Facebook</strong> tire 97 % de ses revenus de la vente de vos données aux annonceurs</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Instagram</strong> analyse vos photos pour identifier vos centres d'intérêt commerciaux</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">TikTok</strong> collecte votre localisation, vos contacts, votre historique de navigation</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Google</strong> combine les données de tous ses services pour créer un profil publicitaire ultra-détaillé</li>
            </ul>
            <p>La protection des données sur Forsure élimine ces pratiques à la source. Nous ne collectons aucune de ces informations.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Ce que la protection des données signifie concrètement sur Forsure</h2>

            <h3 className="text-xl font-bold text-foreground mt-8">Zéro collecte de données inutiles</h3>
            <p>La protection des données sur Forsure commence par la collecte minimale. Nous ne demandons que votre email et votre nom d'utilisateur. Nous ne collectons pas votre historique de navigation, votre localisation, vos contacts téléphoniques, vos habitudes d'achat ou votre empreinte numérique. La protection des données passe d'abord par ne pas collecter ce qui n'est pas nécessaire.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Zéro publicité, zéro tracking</h3>
            <p>La protection des données sur Forsure signifie l'absence totale de publicité et de tracking. Aucun cookie de suivi, aucun pixel espion, aucun script d'analyse comportementale. Quand vous naviguez sur Forsure, votre activité n'est pas enregistrée ni analysée à des fins commerciales. La protection des données est absolue.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Zéro revente de données à des tiers</h3>
            <p>La protection des données sur Forsure inclut l'engagement formel de ne jamais vendre, louer, échanger ou partager vos données personnelles avec des tiers. Aucun annonceur, aucun partenaire commercial, aucune agence n'a accès à vos informations. La protection des données est un engagement contractuel.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Protection des données renforcée pour les enfants et adolescents</h2>
            <p>La protection des données des mineurs est une responsabilité que Forsure prend particulièrement au sérieux. Les réseaux sociaux représentent un risque réel pour les jeunes : cyberharcèlement, prédateurs en ligne, exposition à des contenus inappropriés, collecte de données sans consentement éclairé.</p>
            <p>La protection des données des mineurs sur Forsure inclut des mesures spécifiques :</p>
            <ul className="space-y-2">
              <li>🛡️ <strong className="text-foreground">Messages d'inconnus bloqués</strong> — La protection des données des mineurs bloque par défaut les messages d'adultes non approuvés</li>
              <li>🤖 <strong className="text-foreground">Détection de manipulation</strong> — Notre <Link to="/ia-moderation" className="text-primary hover:underline">intelligence artificielle de modération</Link> détecte les tentatives de manipulation</li>
              <li>👨‍👩‍👧 <strong className="text-foreground">Contrôle parental complet</strong> — La protection des données familiales est entre les mains des parents</li>
              <li>📊 <strong className="text-foreground">Alertes de sécurité</strong> — Notification immédiate aux parents en cas de comportement suspect</li>
              <li>🔒 <strong className="text-foreground">Données minimales collectées</strong> — La protection des données des mineurs implique une collecte encore plus restreinte</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Conformité RGPD et droits des utilisateurs</h2>
            <p>La protection des données sur Forsure est entièrement conforme au Règlement Général sur la Protection des Données (RGPD) de l'Union Européenne. La protection des données est intégrée dès la conception de chaque fonctionnalité (privacy by design et privacy by default). Vous disposez de tous les droits prévus par la loi :</p>
            <ul className="space-y-2">
              <li>✅ <strong className="text-foreground">Droit d'accès</strong> — La protection des données vous donne le droit de consulter toutes les informations que nous détenons</li>
              <li>✅ <strong className="text-foreground">Droit de rectification</strong> — La protection des données vous permet de corriger vos informations à tout moment</li>
              <li>✅ <strong className="text-foreground">Droit à l'effacement</strong> — La protection des données inclut la suppression complète de votre compte et de toutes vos données</li>
              <li>✅ <strong className="text-foreground">Droit à la portabilité</strong> — La protection des données vous permet d'exporter vos données dans un format standard</li>
              <li>✅ <strong className="text-foreground">Droit d'opposition</strong> — La protection des données vous donne le droit de vous opposer au traitement de vos données</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Protection des données : Forsure vs Facebook, Instagram et TikTok</h2>
            <p>La comparaison en matière de protection des données est sans appel :</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 pr-4 text-foreground">Protection des données</th>
                    <th className="text-center py-3 px-2 text-foreground">Forsure</th>
                    <th className="text-center py-3 px-2 text-foreground">Facebook</th>
                    <th className="text-center py-3 px-2 text-foreground">TikTok</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">Publicité ciblée</td><td className="text-center text-primary font-bold">Non ✅</td><td className="text-center">Oui ❌</td><td className="text-center">Oui ❌</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">Revente de données</td><td className="text-center text-primary font-bold">Jamais ✅</td><td className="text-center">Oui ❌</td><td className="text-center">Oui ❌</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">Tracking en ligne</td><td className="text-center text-primary font-bold">Aucun ✅</td><td className="text-center">Intensif ❌</td><td className="text-center">Intensif ❌</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">Chiffrement messages</td><td className="text-center text-primary font-bold">Par défaut ✅</td><td className="text-center">Optionnel ❌</td><td className="text-center">Non ❌</td></tr>
                  <tr><td className="py-2 pr-4">Contrôle parental</td><td className="text-center text-primary font-bold">Intégré ✅</td><td className="text-center">Limité ⚠️</td><td className="text-center">Limité ⚠️</td></tr>
                </tbody>
              </table>
            </div>

            <h2 className="text-2xl font-bold text-foreground mt-10">La protection des données comme engagement fondamental</h2>
            <p>La protection des données sur Forsure n'est pas un argument marketing ou une fonctionnalité secondaire. C'est le fondement même de notre existence. Nous avons créé Forsure parce que nous croyons que les utilisateurs méritent un réseau social qui respecte leur vie privée, protège leurs données personnelles et ne les traite pas comme des produits à vendre.</p>
            <p>Découvrez comment la protection des données sur Forsure est complétée par notre <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée de bout en bout</Link>, notre <Link to="/reseau-social-securise" className="text-primary hover:underline">réseau social sécurisé</Link> et notre <Link to="/feed-intelligent" className="text-primary hover:underline">feed intelligent sans publicité</Link>.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Protéger mes données — inscription gratuite</Button></Link>
            </div>
          </div>
        </div>
      </section>

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
