import { Link } from 'react-router-dom';
import { Sparkles, Heart, Eye, TrendingUp, Clock, Sliders, ChevronDown } from 'lucide-react';
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

const principles = [
  { icon: Heart, title: 'Vos amis d\'abord', desc: 'L\'algorithme de feed intelligent privilégie les publications de vos proches et des comptes que vous suivez. Pas de contenu sponsorisé qui pollue votre fil.' },
  { icon: Eye, title: 'Aucune manipulation', desc: 'Le feed intelligent de Forsure ne contient pas de dark patterns ni de contenu conçu pour provoquer la colère. L\'algorithme vise la pertinence, pas la dépendance.' },
  { icon: TrendingUp, title: 'Contenu de qualité valorisé', desc: 'Le feed intelligent met en avant les publications originales et engageantes. Le clickbait et les contenus trompeurs sont automatiquement rétrogradés.' },
  { icon: Sliders, title: 'Personnalisation transparente', desc: 'Vous pouvez voir et ajuster les paramètres de votre feed intelligent. Aucun facteur caché — vous savez exactement pourquoi chaque contenu apparaît.' },
  { icon: Clock, title: 'Respect de votre temps', desc: 'Le feed intelligent ne cherche pas à maximiser votre temps d\'écran. Il vous montre l\'essentiel rapidement pour préserver votre bien-être numérique.' },
  { icon: Sparkles, title: 'Découverte naturelle', desc: 'Le feed intelligent vous suggère de nouveaux contenus basés sur vos vrais centres d\'intérêt, pas sur ce qui génère le plus de clics ou de revenus publicitaires.' },
];

const faqs = [
  { q: 'Comment fonctionne le feed intelligent de Forsure ?', a: 'Le feed intelligent de Forsure analyse vos interactions — likes, commentaires, partages — pour comprendre vos centres d\'intérêt et vous montrer les contenus les plus pertinents. Contrairement aux algorithmes de Facebook ou TikTok, notre feed intelligent n\'est pas conçu pour maximiser votre temps d\'écran.' },
  { q: 'Le feed intelligent contient-il de la publicité ?', a: 'Non. Le feed intelligent de Forsure ne contient aucune publicité, aucun contenu sponsorisé et aucune publication promue par un budget publicitaire. Chaque contenu que vous voyez est là parce qu\'il est pertinent pour vous.' },
  { q: 'Puis-je personnaliser mon feed intelligent ?', a: 'Oui, le feed intelligent de Forsure est entièrement personnalisable. Vous pouvez ajuster les priorités — voir plus de contenu de vos amis proches, moins de suggestions, plus de vidéos ou plus de texte. Vous gardez le contrôle total.' },
  { q: 'Le feed intelligent favorise-t-il les contenus négatifs ?', a: 'Non, c\'est l\'inverse. Notre feed intelligent est conçu pour privilégier les contenus positifs, informatifs et pertinents. Contrairement aux algorithmes qui favorisent l\'indignation et la colère, Forsure respecte votre bien-être mental.' },
  { q: 'En quoi le feed intelligent est différent de l\'algorithme TikTok ?', a: 'L\'algorithme TikTok est conçu pour vous rendre dépendant en vous montrant du contenu addictif. Le feed intelligent de Forsure vous montre ce qui est pertinent pour vous, sans chercher à maximiser votre temps d\'écran. Vous pouvez aussi voir pourquoi chaque contenu apparaît.' },
  { q: 'Le feed intelligent protège-t-il les mineurs ?', a: 'Oui, le feed intelligent de Forsure adapte le contenu en fonction de l\'âge de l\'utilisateur. Les contenus inappropriés sont automatiquement filtrés pour les mineurs, et l\'algorithme évite de promouvoir des contenus potentiellement nuisibles.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Feed intelligent et éthique — Forsure',
  description: 'Le feed intelligent de Forsure est transparent, sans publicité et respectueux de votre bien-être. Un fil d\'actualité éthique.',
  url: 'https://forsure.fans/feed-intelligent',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOFeed() {
  return (
    <SEOPageLayout
      title="Feed intelligent et éthique — Fil d'actualité sans manipulation ni publicité"
      description="Le feed intelligent de Forsure est transparent, éthique et sans publicité. Un fil d'actualité qui respecte votre temps, votre bien-être et votre vie privée. Zéro dark patterns."
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Sparkles className="w-4 h-4" /> Feed intelligent
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">Le feed intelligent qui respecte votre temps et votre bien-être</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Le feed intelligent de Forsure est transparent, éthique et sans publicité. Découvrez un fil d'actualité conçu pour vous servir, pas pour vous rendre dépendant.</p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
            {principles.map(p => (
              <div key={p.title} className="bg-card border border-border/50 rounded-2xl p-6">
                <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4"><p.icon className="w-5 h-5 text-primary" /></div>
                <h3 className="font-semibold text-foreground mb-2">{p.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{p.desc}</p>
              </div>
            ))}
          </div>

          <div className="max-w-3xl mx-auto space-y-6 text-muted-foreground leading-relaxed">
            <h2 className="text-2xl font-bold text-foreground">Pourquoi les algorithmes des réseaux sociaux sont un problème</h2>
            <p>Les algorithmes de Facebook, Instagram et TikTok ont un objectif unique : maximiser votre temps d'écran. Plus vous restez connecté, plus ils peuvent vous montrer de publicités, et plus ils gagnent d'argent. Pour y parvenir, ces algorithmes favorisent délibérément les contenus qui provoquent des émotions fortes — la colère, l'indignation, la peur, l'anxiété — parce que ces émotions vous poussent à interagir davantage.</p>
            <p>Le résultat ? Des millions de personnes passent des heures à scroller un fil d'actualité rempli de contenus négatifs, de publicités déguisées et de clickbait, sans même s'en rendre compte. Le feed intelligent de Forsure rejette cette approche.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Comment fonctionne le feed intelligent de Forsure</h2>
            <p>Le feed intelligent de Forsure analyse vos interactions — likes, commentaires, partages, temps de lecture — pour comprendre ce qui vous intéresse vraiment. Mais contrairement aux autres algorithmes, il ne cherche pas à vous garder connecté le plus longtemps possible. Son objectif est de vous montrer l'essentiel rapidement et efficacement.</p>
            <p>Le feed intelligent classe les contenus selon plusieurs critères transparents :</p>
            <ul className="space-y-2">
              <li>👥 <strong className="text-foreground">Relation avec l'auteur</strong> — Les publications de vos amis proches et de votre famille sont prioritaires dans votre feed intelligent</li>
              <li>⏰ <strong className="text-foreground">Fraîcheur du contenu</strong> — Le feed intelligent privilégie les contenus récents et pertinents</li>
              <li>💬 <strong className="text-foreground">Engagement authentique</strong> — Les contenus qui génèrent des commentaires constructifs sont valorisés par le feed intelligent</li>
              <li>🎯 <strong className="text-foreground">Pertinence pour vous</strong> — Le feed intelligent apprend vos centres d'intérêt sans vous enfermer dans une bulle</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Transparent et contrôlable : vous gardez le pouvoir</h2>
            <p>La grande différence du feed intelligent de Forsure, c'est la transparence. Vous pouvez à tout moment consulter les facteurs qui influencent votre fil d'actualité et les ajuster selon vos préférences. Vous voulez voir plus de contenu de vos amis proches ? Moins de suggestions de nouveaux créateurs ? Plus de vidéos et moins de texte ? Tout est personnalisable dans les réglages de votre feed intelligent.</p>
            <p>Sur Facebook ou TikTok, vous n'avez aucune idée de pourquoi un contenu apparaît dans votre fil. Sur Forsure, chaque recommandation du feed intelligent est expliquée.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Zéro publicité, zéro contenu sponsorisé déguisé</h2>
            <p>Sur les autres réseaux sociaux, entre 20 % et 30 % du contenu de votre fil est de la publicité déguisée en contenu organique. Le feed intelligent de Forsure ne contient aucune publicité — ni affichée, ni cachée, ni "native". Chaque publication que vous voyez est là parce qu'elle est pertinente pour vous, pas parce qu'un annonceur a payé pour la mettre en avant.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Un feed intelligent qui protège votre santé mentale</h2>
            <p>De nombreuses études ont montré que les algorithmes des réseaux sociaux traditionnels ont un impact négatif sur la santé mentale, particulièrement chez les jeunes. Le feed intelligent de Forsure a été conçu pour contrer ces effets : il évite de promouvoir les contenus anxiogènes, il ne favorise pas la comparaison sociale et il respecte votre temps de déconnexion.</p>
            <p>Combiné avec notre <Link to="/ia-moderation" className="text-primary hover:underline">intelligence artificielle de modération</Link> qui filtre les contenus toxiques et notre <Link to="/protection-donnees" className="text-primary hover:underline">protection des données personnelles</Link>, le feed intelligent de Forsure crée un environnement numérique sain et respectueux.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Découvrez un fil d'actualité qui vous respecte</h2>
            <p>Le feed intelligent de Forsure prouve qu'il est possible de créer un algorithme performant sans manipuler les émotions des utilisateurs. Un fil d'actualité peut être pertinent, engageant et respectueux de votre bien-être — il suffit de le concevoir différemment. Rejoignez les utilisateurs qui ont choisi un feed intelligent éthique.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Essayer le feed intelligent gratuitement</Button></Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 md:py-24 bg-muted/20" itemScope itemType="https://schema.org/FAQPage">
        <div className="max-w-3xl mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-center mb-10">Questions fréquentes sur le feed intelligent</h2>
          <div className="space-y-3">
            {faqs.map(f => <FAQItem key={f.q} q={f.q} a={f.a} />)}
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
