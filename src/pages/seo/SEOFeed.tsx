import { Link } from 'react-router-dom';
import { Sparkles, Heart, Eye, TrendingUp, Clock, Sliders, ChevronDown, CheckCircle } from 'lucide-react';
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
  { icon: Heart, title: 'Vos amis d\'abord', desc: 'Le feed intelligent de Forsure privilégie les publications de vos proches. Pas de contenu sponsorisé qui pollue votre fil d\'actualité.' },
  { icon: Eye, title: 'Aucune manipulation', desc: 'Le feed intelligent ne contient pas de dark patterns ni de contenu conçu pour provoquer la colère. L\'algorithme du feed intelligent vise la pertinence.' },
  { icon: TrendingUp, title: 'Contenu de qualité', desc: 'Le feed intelligent met en avant les publications originales. Le clickbait est automatiquement rétrogradé par le feed intelligent.' },
  { icon: Sliders, title: 'Personnalisation transparente', desc: 'Le feed intelligent vous laisse voir et ajuster ses paramètres. Vous comprenez pourquoi chaque contenu apparaît dans votre feed intelligent.' },
  { icon: Clock, title: 'Respect de votre temps', desc: 'Le feed intelligent ne maximise pas votre temps d\'écran. Il vous montre l\'essentiel rapidement pour préserver votre bien-être.' },
  { icon: Sparkles, title: 'Découverte naturelle', desc: 'Le feed intelligent vous suggère de nouveaux contenus basés sur vos vrais centres d\'intérêt, pas sur ce qui génère des revenus publicitaires.' },
];

const faqs = [
  { q: 'Comment fonctionne le feed intelligent de Forsure ?', a: 'Le feed intelligent de Forsure analyse vos interactions — likes, commentaires, partages — pour comprendre vos centres d\'intérêt et vous montrer les contenus les plus pertinents. Le feed intelligent ne cherche pas à maximiser votre temps d\'écran.' },
  { q: 'Le feed intelligent contient-il de la publicité ?', a: 'Non. Le feed intelligent de Forsure ne contient aucune publicité, aucun contenu sponsorisé et aucune publication promue. Chaque contenu dans votre feed intelligent est là parce qu\'il est pertinent pour vous.' },
  { q: 'Puis-je personnaliser mon feed intelligent ?', a: 'Oui, le feed intelligent de Forsure est entièrement personnalisable. Vous pouvez ajuster les priorités de votre feed intelligent : voir plus de contenu de vos amis, moins de suggestions, ou filtrer par type de contenu.' },
  { q: 'Le feed intelligent favorise-t-il les contenus négatifs ?', a: 'Non, c\'est l\'inverse. Le feed intelligent de Forsure est conçu pour privilégier les contenus positifs et informatifs. Contrairement aux algorithmes qui favorisent l\'indignation, le feed intelligent respecte votre bien-être.' },
  { q: 'En quoi le feed intelligent est différent de l\'algorithme TikTok ?', a: 'L\'algorithme TikTok est conçu pour vous rendre dépendant. Le feed intelligent de Forsure vous montre ce qui est pertinent sans chercher à maximiser votre temps d\'écran. De plus, le feed intelligent vous explique pourquoi chaque contenu apparaît.' },
  { q: 'Le feed intelligent protège-t-il les mineurs ?', a: 'Oui, le feed intelligent de Forsure adapte le contenu en fonction de l\'âge. Les contenus inappropriés sont automatiquement filtrés par le feed intelligent pour les utilisateurs mineurs.' },
  { q: 'Le feed intelligent est-il le même pour tous les utilisateurs ?', a: 'Non, le feed intelligent de Forsure est personnalisé pour chaque utilisateur en fonction de ses centres d\'intérêt et de ses interactions. Chaque feed intelligent est unique.' },
  { q: 'Pourquoi le feed intelligent est-il meilleur pour ma santé mentale ?', a: 'Le feed intelligent de Forsure ne favorise pas les contenus anxiogènes ou provocants. Contrairement aux algorithmes classiques qui exploitent vos émotions négatives, le feed intelligent privilégie les contenus positifs et constructifs.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Feed intelligent et éthique — Fil d\'actualité sans manipulation — Forsure',
  description: 'Le feed intelligent de Forsure est transparent, sans publicité et respectueux de votre bien-être. Un fil d\'actualité éthique et personnalisable.',
  url: 'https://forsure.fans/feed-intelligent',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOFeed() {
  return (
    <SEOPageLayout
      title="Fil d'actualité personnalisé — Algorithme transparent et éthique"
      description="Fil d'actualité personnalisé sur Forsure avec un algorithme transparent que vous contrôlez. Sans publicité, sans manipulation, sans dark patterns. Un feed qui respecte votre bien-être."
      url="https://forsure.fans/feed-intelligent"
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Sparkles className="w-4 h-4" /> Feed intelligent
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">Le feed intelligent qui respecte votre temps et votre bien-être numérique</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Le feed intelligent de Forsure est transparent, éthique et sans publicité. Un fil d'actualité conçu pour vous servir, pas pour vous rendre dépendant.</p>
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
            <h2 className="text-2xl font-bold text-foreground">Pourquoi les algorithmes des réseaux sociaux sont devenus un problème de société</h2>
            <p>En 2025, les algorithmes des réseaux sociaux sont au cœur d'un débat mondial. Les algorithmes de Facebook, Instagram et TikTok ont un objectif unique et redoutable : maximiser votre temps d'écran. Plus vous restez connecté, plus ils peuvent vous montrer de publicités, et plus ils gagnent d'argent. Pour y parvenir, ces algorithmes favorisent délibérément les contenus qui provoquent des émotions fortes — la colère, l'indignation, la peur, l'anxiété.</p>
            <p>Le résultat est dévastateur : des millions de personnes passent des heures à scroller un fil d'actualité rempli de contenus négatifs, de publicités déguisées et de clickbait, sans même s'en rendre compte. Le feed intelligent de Forsure rejette fondamentalement cette approche toxique.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Les conséquences des algorithmes traditionnels</h3>
            <p>Les études scientifiques sont unanimes sur les effets néfastes des algorithmes classiques. Le feed intelligent de Forsure a été créé pour contrer ces effets :</p>
            <ul className="space-y-2">
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Addiction aux écrans</strong> — Les algorithmes classiques sont conçus pour créer de la dépendance. Le feed intelligent de Forsure respecte votre temps.</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Anxiété et dépression</strong> — Les contenus négatifs favorisés par les algorithmes augmentent le stress. Le feed intelligent privilégie les contenus positifs.</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Désinformation</strong> — Les fake news génèrent plus d'engagement et sont favorisées. Le feed intelligent de Forsure rétrograde le clickbait.</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Bulle de filtre</strong> — Les algorithmes vous enferment dans vos opinions. Le feed intelligent de Forsure encourage la diversité des contenus.</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Comment fonctionne le feed intelligent de Forsure en détail</h2>
            <p>Le feed intelligent de Forsure analyse vos interactions — likes, commentaires, partages, temps de lecture — pour comprendre ce qui vous intéresse vraiment. Mais la différence fondamentale est dans l'objectif : le feed intelligent ne cherche pas à vous garder connecté le plus longtemps possible. Son objectif est de vous montrer l'essentiel rapidement et efficacement.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Les critères du feed intelligent</h3>
            <p>Le feed intelligent de Forsure classe les contenus selon plusieurs critères transparents que vous pouvez consulter et ajuster à tout moment :</p>
            <ul className="space-y-3">
              <li>👥 <strong className="text-foreground">Relation avec l'auteur</strong> — Le feed intelligent donne la priorité aux publications de vos amis proches et de votre famille</li>
              <li>⏰ <strong className="text-foreground">Fraîcheur du contenu</strong> — Le feed intelligent privilégie les contenus récents et d'actualité</li>
              <li>💬 <strong className="text-foreground">Engagement authentique</strong> — Le feed intelligent valorise les contenus qui génèrent des discussions constructives</li>
              <li>🎯 <strong className="text-foreground">Pertinence personnelle</strong> — Le feed intelligent apprend vos centres d'intérêt sans vous enfermer dans une bulle</li>
              <li>⭐ <strong className="text-foreground">Qualité du contenu</strong> — Le feed intelligent favorise les publications originales et rétrograde le contenu de faible qualité</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Feed intelligent Forsure vs algorithmes Facebook, Instagram et TikTok</h2>

            <h3 className="text-xl font-bold text-foreground mt-8">Feed intelligent Forsure vs algorithme Facebook</h3>
            <p>L'algorithme de Facebook favorise les contenus qui génèrent de l'engagement — souvent les contenus polémiques, provocants ou anxiogènes. De plus, entre 20 % et 30 % du contenu de votre fil Facebook est de la publicité déguisée. Le feed intelligent de Forsure ne contient aucune publicité et ne favorise jamais les contenus négatifs.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Feed intelligent Forsure vs algorithme Instagram</h3>
            <p>Instagram utilise son algorithme pour maximiser le temps que vous passez à scroller, en favorisant les contenus visuels addictifs et les Reels sponsorisés. Le feed intelligent de Forsure respecte votre temps : il vous montre l'essentiel sans vous pousser à une consommation compulsive.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Feed intelligent Forsure vs algorithme TikTok</h3>
            <p>L'algorithme TikTok est reconnu comme le plus addictif jamais créé. Il analyse votre comportement en détail — combien de temps vous regardez chaque vidéo, où vous vous arrêtez, ce que vous re-regardez — pour vous servir un flux infini de contenu addictif. Le feed intelligent de Forsure prend l'approche inverse : il vous montre ce qui est pertinent et vous encourage à déconnecter.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Le feed intelligent et la personnalisation transparente</h2>
            <p>La grande différence du feed intelligent de Forsure est sa transparence totale. Sur Facebook ou TikTok, vous n'avez aucune idée de pourquoi un contenu apparaît dans votre fil ni comment l'algorithme fonctionne. Le feed intelligent de Forsure vous donne un contrôle total :</p>
            <ul className="space-y-2">
              <li>🔍 <strong className="text-foreground">Explication de chaque recommandation</strong> — Le feed intelligent vous explique pourquoi chaque contenu apparaît</li>
              <li>⚙️ <strong className="text-foreground">Réglages personnalisables</strong> — Ajustez les priorités du feed intelligent selon vos préférences</li>
              <li>📊 <strong className="text-foreground">Statistiques d'utilisation</strong> — Le feed intelligent vous montre combien de temps vous passez et vous aide à gérer votre temps</li>
              <li>🔕 <strong className="text-foreground">Mode déconnexion</strong> — Le feed intelligent peut vous rappeler de faire une pause et de profiter de la vie hors ligne</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Le feed intelligent et la protection des mineurs</h2>
            <p>Le feed intelligent de Forsure accorde une attention particulière aux utilisateurs les plus jeunes. Pour les mineurs, le feed intelligent filtre automatiquement les contenus inappropriés, évite de promouvoir les contenus potentiellement nuisibles et limite les recommandations de contenus produits par des inconnus. Combiné avec notre <Link to="/protection-donnees" className="text-primary hover:underline">protection des données personnelles</Link> et notre <Link to="/ia-moderation" className="text-primary hover:underline">intelligence artificielle de modération</Link>, le feed intelligent crée un environnement sûr pour les jeunes utilisateurs.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Un feed intelligent pour un Internet plus sain</h2>
            <p>Le feed intelligent de Forsure prouve qu'il est possible de créer un algorithme performant sans manipuler les émotions des utilisateurs. Un fil d'actualité peut être pertinent, engageant et respectueux de votre bien-être — il suffit de le concevoir avec les bonnes intentions. Le feed intelligent de Forsure est la preuve qu'un autre modèle est possible.</p>
            <p>Rejoignez les utilisateurs qui ont choisi un feed intelligent éthique, intégré dans un <Link to="/reseau-social-securise" className="text-primary hover:underline">réseau social sécurisé</Link> avec une <Link to="/messagerie-chiffree" className="text-primary hover:underline">messagerie chiffrée de bout en bout</Link>.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Essayer le feed intelligent gratuitement</Button></Link>
            </div>
          </div>
        </div>
      </section>

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
