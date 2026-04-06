import { Link } from 'react-router-dom';
import { Lock, ShieldCheck, Key, Fingerprint, RefreshCw, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SEOPageLayout } from '@/components/seo/SEOPageLayout';

const points = [
  { icon: Lock, title: 'Chiffrement de bout en bout', desc: 'Chaque message est verrouillé par une clé unique. Seuls vous et votre correspondant pouvez le lire. Personne d\'autre — pas même Forsure.' },
  { icon: Key, title: 'Clés de sécurité personnelles', desc: 'Vos clés de chiffrement sont stockées sur votre appareil, jamais sur nos serveurs. Vous gardez le contrôle total de vos conversations.' },
  { icon: RefreshCw, title: 'Renouvellement automatique', desc: 'Les clés de chiffrement se renouvellent à chaque message (protocole Double Ratchet). Même si une clé est compromise, les messages précédents restent protégés.' },
  { icon: Fingerprint, title: 'Vérification d\'identité', desc: 'Vous pouvez vérifier l\'identité de vos contacts grâce aux empreintes de sécurité, garantissant que vous parlez bien à la bonne personne.' },
  { icon: Server, title: 'Aucun stockage en clair', desc: 'Nos serveurs ne voient jamais le contenu de vos messages. Ils transitent chiffrés et sont déchiffrés uniquement sur votre appareil.' },
  { icon: ShieldCheck, title: 'Protocoles reconnus', desc: 'Forsure utilise les protocoles X3DH et Double Ratchet, les mêmes standards que Signal, la référence mondiale en matière de messagerie sécurisée.' },
];

export default function SEOMessaging() {
  return (
    <SEOPageLayout
      title="Messagerie chiffrée de bout en bout — Conversations 100% privées"
      description="La messagerie Forsure utilise le chiffrement de bout en bout pour protéger toutes vos conversations. Protocoles Signal, zéro accès serveur. Vos messages restent privés."
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Lock className="w-4 h-4" /> Messagerie privée
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">Messagerie chiffrée de bout en bout</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Vos conversations sont protégées par les mêmes protocoles que Signal. Personne ne peut lire vos messages — pas même nous.</p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
            {points.map(p => (
              <div key={p.title} className="bg-card border border-border/50 rounded-2xl p-6">
                <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4"><p.icon className="w-5 h-5 text-primary" /></div>
                <h3 className="font-semibold text-foreground mb-2">{p.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{p.desc}</p>
              </div>
            ))}
          </div>

          <div className="max-w-3xl mx-auto space-y-6 text-muted-foreground leading-relaxed">
            <h2 className="text-2xl font-bold text-foreground">Comment fonctionne le chiffrement sur Forsure ?</h2>
            <p>Quand vous envoyez un message sur Forsure, il est automatiquement chiffré sur votre appareil avant d'être envoyé. Le message voyage sur Internet sous forme de code illisible. Seul l'appareil de votre correspondant possède la clé pour le déchiffrer.</p>
            <p>Ce processus est entièrement automatique et transparent. Vous n'avez rien à configurer : chaque conversation est protégée dès le premier message.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Pourquoi c'est important ?</h2>
            <p>Sur la plupart des réseaux sociaux et messageries classiques, vos messages sont stockés en clair sur les serveurs de l'entreprise. Cela signifie que l'entreprise, ses employés, et potentiellement des pirates ou des agences gouvernementales peuvent accéder à vos conversations.</p>
            <p>Avec le chiffrement de bout en bout de Forsure, cette situation est techniquement impossible. Même en cas de piratage de nos serveurs, vos messages restent illisibles car les clés de déchiffrement n'y sont jamais stockées.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Aussi simple que n'importe quelle messagerie</h2>
            <p>Pas besoin d'être expert en informatique. Forsure fonctionne exactement comme les messageries que vous connaissez — texte, photos, vidéos, messages vocaux, GIF, appels vidéo — mais avec une couche de protection invisible qui garantit votre vie privée.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Essayer la messagerie sécurisée</Button></Link>
            </div>
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
