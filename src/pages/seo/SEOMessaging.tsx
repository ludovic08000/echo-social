import { Link } from 'react-router-dom';
import { Lock, ShieldCheck, Key, Fingerprint, RefreshCw, Server, ChevronDown } from 'lucide-react';
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

const points = [
  { icon: Lock, title: 'Messagerie chiffrée de bout en bout', desc: 'Chaque message est verrouillé par une clé unique. Seuls vous et votre correspondant pouvez le lire. Personne d\'autre — pas même Forsure — n\'a accès à vos conversations.' },
  { icon: Key, title: 'Clés de sécurité sur votre appareil', desc: 'Vos clés de chiffrement sont stockées uniquement sur votre téléphone ou ordinateur, jamais sur nos serveurs. Vous gardez le contrôle total de votre messagerie chiffrée.' },
  { icon: RefreshCw, title: 'Sécurité renouvelée à chaque message', desc: 'Les clés de protection se renouvellent automatiquement à chaque message envoyé. Même si une clé était compromise, tous vos messages précédents resteraient protégés.' },
  { icon: Fingerprint, title: 'Vérification d\'identité des contacts', desc: 'Vérifiez que vous parlez bien à la bonne personne grâce aux empreintes de sécurité. Une protection supplémentaire contre l\'usurpation d\'identité.' },
  { icon: Server, title: 'Zéro accès serveur à vos messages', desc: 'Nos serveurs ne voient jamais le contenu de vos messages. Ils transitent sous forme de code illisible et ne sont déchiffrés que sur votre appareil.' },
  { icon: ShieldCheck, title: 'Même technologie que Signal', desc: 'La messagerie chiffrée de Forsure utilise les mêmes protocoles que Signal, la référence mondiale en matière de confidentialité des communications.' },
];

const faqs = [
  { q: 'Comment fonctionne la messagerie chiffrée de Forsure ?', a: 'Quand vous envoyez un message sur Forsure, il est automatiquement transformé en code illisible sur votre appareil avant d\'être envoyé. Seul l\'appareil de votre correspondant possède la clé pour le déchiffrer et le lire. Ce processus est entièrement automatique — vous n\'avez rien à configurer pour utiliser notre messagerie chiffrée.' },
  { q: 'Forsure peut-il lire mes messages ?', a: 'Non, absolument pas. Grâce au chiffrement de bout en bout de notre messagerie chiffrée, personne ne peut lire vos messages — pas même l\'équipe Forsure. Les clés de déchiffrement n\'existent que sur votre appareil et celui de votre correspondant.' },
  { q: 'Ma messagerie chiffrée protège-t-elle aussi les photos et vidéos ?', a: 'Oui, tout est protégé par le même niveau de chiffrement : textes, photos, vidéos, messages vocaux, documents, GIF. Les appels vidéo et audio sont également chiffrés de bout en bout sur notre messagerie chiffrée.' },
  { q: 'Quelle est la différence avec WhatsApp ou Messenger ?', a: 'Contrairement à WhatsApp (propriété de Meta/Facebook), Forsure ne collecte aucune métadonnée sur vos conversations. Notre messagerie chiffrée ne partage pas vos contacts, votre localisation ou vos habitudes d\'utilisation avec des annonceurs. Messenger de Facebook n\'est même pas chiffré de bout en bout par défaut.' },
  { q: 'Que se passe-t-il si je perds mon téléphone ?', a: 'Vos messages restent protégés. Sans votre appareil et vos clés de chiffrement, personne ne peut accéder à l\'historique de votre messagerie chiffrée. Vous pouvez configurer une sauvegarde sécurisée pour restaurer vos conversations sur un nouvel appareil.' },
  { q: 'La messagerie chiffrée fonctionne-t-elle dans les groupes ?', a: 'Oui, les conversations de groupe bénéficient du même niveau de protection que les conversations individuelles. Chaque message est chiffré pour chaque participant du groupe sur notre messagerie chiffrée.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Messagerie chiffrée de bout en bout — Forsure',
  description: 'La messagerie chiffrée de Forsure protège toutes vos conversations avec un chiffrement de bout en bout. Aussi sécurisé que Signal, aussi simple que WhatsApp.',
  url: 'https://forsure.fans/messagerie-chiffree',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOMessaging() {
  return (
    <SEOPageLayout
      title="Messagerie chiffrée de bout en bout — Conversations 100% privées"
      description="La messagerie chiffrée de Forsure protège toutes vos conversations avec un chiffrement de bout en bout. Aussi sécurisé que Signal, aussi simple à utiliser. Textes, photos, vidéos, appels — tout est protégé."
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Lock className="w-4 h-4" /> Messagerie chiffrée
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">La messagerie chiffrée qui protège vraiment vos conversations</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Sur Forsure, chaque message est protégé par une messagerie chiffrée de bout en bout. Personne ne peut lire vos conversations — pas même nous.</p>
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
            <h2 className="text-2xl font-bold text-foreground">Pourquoi utiliser une messagerie chiffrée en 2025 ?</h2>
            <p>Chaque jour, des milliards de messages sont échangés sur les réseaux sociaux et les applications de messagerie. La plupart de ces messages transitent en clair sur les serveurs des entreprises qui les hébergent — Facebook Messenger, Instagram Direct, Twitter DM. Cela signifie que l'entreprise, ses employés, et potentiellement des pirates informatiques peuvent accéder à vos conversations les plus intimes.</p>
            <p>La messagerie chiffrée de Forsure élimine ce risque. Grâce au chiffrement de bout en bout, vos messages sont transformés en code illisible sur votre appareil avant d'être envoyés. Ils ne sont déchiffrés que sur l'appareil de votre correspondant. Même si quelqu'un interceptait vos messages en transit, il ne verrait qu'une suite de caractères incompréhensible.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Comment fonctionne notre messagerie chiffrée ?</h2>
            <p>Le processus de chiffrement est entièrement automatique et invisible pour l'utilisateur. Quand vous envoyez un message, voici ce qui se passe en coulisses :</p>
            <ul className="space-y-2">
              <li>1️⃣ <strong className="text-foreground">Votre message est chiffré</strong> sur votre appareil avec une clé unique que seul votre correspondant possède</li>
              <li>2️⃣ <strong className="text-foreground">Le message voyage sur Internet</strong> sous forme de code illisible — même nos serveurs ne peuvent pas le lire</li>
              <li>3️⃣ <strong className="text-foreground">Votre correspondant le déchiffre</strong> automatiquement sur son appareil grâce à sa clé privée</li>
              <li>4️⃣ <strong className="text-foreground">La clé est renouvelée</strong> pour le prochain message, offrant une protection toujours plus forte</li>
            </ul>
            <p>Ce renouvellement constant des clés signifie que même dans le scénario improbable où une clé serait compromise, seul un message pourrait être affecté — tous les autres resteraient protégés par la messagerie chiffrée.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Plus sécurisé que WhatsApp, plus simple que Signal</h2>
            <p>WhatsApp appartient à Meta (Facebook) et partage vos métadonnées — qui vous contactez, quand, combien de temps, depuis où — avec le groupe Meta à des fins publicitaires. Notre messagerie chiffrée ne collecte aucune de ces informations.</p>
            <p>Signal est excellent en termes de sécurité, mais reste une application séparée que peu de gens utilisent au quotidien. Forsure intègre une messagerie chiffrée de même niveau directement dans un réseau social complet — avec fil d'actualité, stories, lives, marketplace et appels vidéo. Tout est protégé, tout est intégré.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Tout est protégé, pas seulement les textes</h2>
            <p>La messagerie chiffrée de Forsure ne se limite pas aux messages texte. Chaque type de contenu que vous partagez bénéficie du même niveau de protection :</p>
            <ul className="space-y-2">
              <li>📝 <strong className="text-foreground">Messages texte</strong> — Chiffrés de bout en bout</li>
              <li>📸 <strong className="text-foreground">Photos et vidéos</strong> — Chiffrées avant l'envoi</li>
              <li>🎤 <strong className="text-foreground">Messages vocaux</strong> — Protégés par le même chiffrement</li>
              <li>📎 <strong className="text-foreground">Documents et fichiers</strong> — Transmis de façon sécurisée</li>
              <li>📞 <strong className="text-foreground">Appels vidéo et audio</strong> — Chiffrés en temps réel</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">Votre vie privée mérite une vraie messagerie chiffrée</h2>
            <p>Dans un monde où les violations de données font régulièrement la une de l'actualité, protéger ses conversations n'est plus un luxe — c'est une nécessité. La messagerie chiffrée de Forsure vous offre cette protection gratuitement, sans compromis sur la simplicité d'utilisation.</p>
            <p>Découvrez également comment notre <Link to="/reseau-social-securise" className="text-primary hover:underline">réseau social sécurisé</Link> protège votre compte et comment notre <Link to="/ia-moderation" className="text-primary hover:underline">intelligence artificielle de modération</Link> garantit un environnement sain pour tous.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Essayer la messagerie chiffrée gratuitement</Button></Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 md:py-24 bg-muted/20" itemScope itemType="https://schema.org/FAQPage">
        <div className="max-w-3xl mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-center mb-10">Questions fréquentes sur la messagerie chiffrée</h2>
          <div className="space-y-3">
            {faqs.map(f => <FAQItem key={f.q} q={f.q} a={f.a} />)}
          </div>
        </div>
      </section>
    </SEOPageLayout>
  );
}
