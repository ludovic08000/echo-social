import { Link } from 'react-router-dom';
import { Sparkles, Heart, Eye, TrendingUp, Clock, Sliders } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SEOPageLayout } from '@/components/seo/SEOPageLayout';

const principles = [
  { icon: Heart, title: 'Vos amis d\'abord', desc: 'L\'algorithme privilégie les publications de vos proches et des comptes que vous suivez activement. Pas de contenu sponsorisé qui s\'immisce dans votre fil.' },
  { icon: Eye, title: 'Aucune manipulation', desc: 'Pas de dark patterns, pas de contenu conçu pour provoquer la colère ou l\'indignation. L\'algorithme vise la pertinence, pas la dépendance.' },
  { icon: TrendingUp, title: 'Contenu de qualité valorisé', desc: 'Les publications originales et engageantes sont mises en avant. Le clickbait et les contenus trompeurs sont automatiquement rétrogradés.' },
  { icon: Sliders, title: 'Personnalisation transparente', desc: 'Vous pouvez voir et ajuster les paramètres de votre fil d\'actualité. Aucun facteur caché — vous savez exactement pourquoi chaque contenu apparaît.' },
  { icon: Clock, title: 'Respect de votre temps', desc: 'L\'algorithme ne cherche pas à maximiser votre temps d\'écran. Il vous montre l\'essentiel rapidement pour que vous puissiez profiter de votre vie hors ligne.' },
  { icon: Sparkles, title: 'Découverte naturelle', desc: 'De nouveaux contenus et créateurs vous sont suggérés en fonction de vos vrais centres d\'intérêt, pas en fonction de ce qui génère le plus de clics.' },
];

export default function SEOFeed() {
  return (
    <SEOPageLayout
      title="Algorithme de feed intelligent et éthique — Fil d'actualité sans manipulation"
      description="L'algorithme de Forsure est transparent et éthique. Pas de dark patterns, pas de contenu sponsorisé déguisé. Un fil d'actualité qui respecte votre temps et votre bien-être."
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Sparkles className="w-4 h-4" /> Feed intelligent
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">Un fil d'actualité conçu pour vous, pas contre vous</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">L'algorithme de Forsure est transparent, éthique et respectueux de votre bien-être. Découvrez ce qui compte vraiment.</p>
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
            <h2 className="text-2xl font-bold text-foreground">Comment fonctionne l'algorithme de Forsure ?</h2>
            <p>L'algorithme de Forsure analyse vos interactions — likes, commentaires, partages — pour comprendre vos centres d'intérêt et vous montrer les contenus les plus pertinents. Mais contrairement aux algorithmes de Facebook ou TikTok, il n'est pas conçu pour maximiser votre temps passé sur l'application.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Transparent et contrôlable</h2>
            <p>Vous pouvez à tout moment consulter les facteurs qui influencent votre fil d'actualité et les ajuster. Vous voulez voir plus de contenu de vos amis proches et moins de suggestions ? Un simple réglage suffit. Chez Forsure, vous êtes aux commandes.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Zéro contenu sponsorisé déguisé</h2>
            <p>Sur Forsure, aucun contenu n'apparaît dans votre fil parce qu'un annonceur a payé pour ça. Chaque publication que vous voyez est là parce qu'elle est pertinente pour vous, pas parce qu'elle a été promue par un budget publicitaire.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Découvrir un feed éthique</Button></Link>
            </div>
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
