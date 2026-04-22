import { Link } from 'react-router-dom';
import { Lock, ShieldCheck, Key, Fingerprint, RefreshCw, Server, ChevronDown, CheckCircle } from 'lucide-react';
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
  { icon: Lock, title: 'Messagerie chiffrée de bout en bout', desc: 'Chaque message sur la messagerie chiffrée Forsure est verrouillé par une clé unique. Seuls vous et votre correspondant pouvez le lire. Personne d\'autre n\'a accès à vos conversations.' },
  { icon: Key, title: 'Clés stockées sur votre appareil', desc: 'Les clés de votre messagerie chiffrée sont stockées uniquement sur votre téléphone ou ordinateur, jamais sur nos serveurs. Vous gardez le contrôle total.' },
  { icon: RefreshCw, title: 'Protection renouvelée à chaque message', desc: 'La messagerie chiffrée Forsure renouvelle automatiquement les clés à chaque message. Si une clé était compromise, tous vos messages précédents resteraient protégés.' },
  { icon: Fingerprint, title: 'Vérification d\'identité', desc: 'La messagerie chiffrée vous permet de vérifier l\'identité de vos contacts. Une protection supplémentaire contre l\'usurpation d\'identité.' },
  { icon: Server, title: 'Zéro accès serveur', desc: 'Nos serveurs ne voient jamais le contenu de vos messages sur la messagerie chiffrée. Ils transitent sous forme de code illisible et ne sont déchiffrés que sur votre appareil.' },
  { icon: ShieldCheck, title: 'Même technologie que Signal', desc: 'La messagerie chiffrée de Forsure utilise les mêmes protocoles de sécurité que Signal, la référence mondiale en matière de confidentialité.' },
];

const faqs = [
  { q: 'Comment fonctionne la messagerie chiffrée de Forsure ?', a: 'La messagerie chiffrée de Forsure transforme automatiquement chaque message en code illisible sur votre appareil avant de l\'envoyer. Seul l\'appareil de votre correspondant possède la clé pour le déchiffrer. Ce processus est entièrement automatique — vous n\'avez rien à configurer pour utiliser la messagerie chiffrée.' },
  { q: 'Forsure peut-il lire mes messages sur la messagerie chiffrée ?', a: 'Non, c\'est impossible. Grâce au chiffrement de bout en bout de la messagerie chiffrée, personne ne peut lire vos messages — pas même l\'équipe Forsure. Les clés de déchiffrement n\'existent que sur votre appareil et celui de votre correspondant.' },
  { q: 'La messagerie chiffrée protège-t-elle aussi les photos et vidéos ?', a: 'Oui, la messagerie chiffrée de Forsure protège absolument tout : textes, photos, vidéos, messages vocaux, documents, GIF. Les appels vidéo et audio sont également chiffrés de bout en bout.' },
  { q: 'Quelle est la différence entre la messagerie chiffrée Forsure et WhatsApp ?', a: 'WhatsApp appartient à Meta (Facebook) et partage vos métadonnées avec le groupe Meta pour la publicité ciblée. La messagerie chiffrée Forsure ne collecte aucune métadonnée et ne partage rien avec des annonceurs.' },
  { q: 'Que se passe-t-il si je perds mon téléphone ? La messagerie chiffrée protège-t-elle mes données ?', a: 'Oui, vos messages restent protégés par la messagerie chiffrée. Sans votre appareil et vos clés de chiffrement, personne ne peut accéder à l\'historique de vos conversations. Vous pouvez configurer une sauvegarde sécurisée pour restaurer vos messages.' },
  { q: 'La messagerie chiffrée fonctionne-t-elle dans les conversations de groupe ?', a: 'Oui, la messagerie chiffrée de Forsure protège les conversations de groupe avec le même niveau de sécurité que les conversations individuelles. Chaque message est chiffré pour chaque participant.' },
  { q: 'La messagerie chiffrée Forsure est-elle gratuite ?', a: 'Oui, la messagerie chiffrée de Forsure est 100 % gratuite. Le chiffrement de bout en bout est inclus par défaut pour tous les utilisateurs, sans abonnement ni frais cachés.' },
  { q: 'Pourquoi la messagerie chiffrée est-elle importante pour ma vie privée ?', a: 'Sans messagerie chiffrée, vos messages peuvent être lus par l\'entreprise qui héberge le service, par des pirates, ou même par des gouvernements. La messagerie chiffrée de Forsure rend cette lecture techniquement impossible, protégeant votre vie privée de manière absolue.' },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Messagerie chiffrée de bout en bout — Conversations privées — Forsure',
  description: 'La messagerie chiffrée de Forsure protège toutes vos conversations avec un chiffrement de bout en bout. Aussi sécurisé que Signal, 100% gratuit.',
  url: 'https://forsure.fans/messagerie-chiffree',
  isPartOf: { '@type': 'WebSite', name: 'Forsure', url: 'https://forsure.fans' },
};

export default function SEOMessaging() {
  return (
    <SEOPageLayout
      title="Messagerie chiffrée bout en bout — Conversations privées et sécurisées"
      description="Messagerie chiffrée bout en bout sur Forsure : vos conversations privées restent 100% confidentielles. Textes, photos, vidéos et appels protégés comme sur Signal, gratuitement."
      url="https://forsure.fans/messagerie-chiffree"
      jsonLd={jsonLd}
    >
      <section className="py-16 md:py-24">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1.5 rounded-full text-sm font-medium mb-4">
              <Lock className="w-4 h-4" /> Messagerie chiffrée
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-foreground mb-4">La messagerie chiffrée qui protège vraiment vos conversations</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">La messagerie chiffrée de Forsure garantit que personne ne peut lire vos messages — pas même nous. Vos conversations restent 100 % privées, toujours.</p>
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
            <p>Chaque jour, des milliards de messages sont échangés sur les réseaux sociaux et les applications de messagerie. La grande majorité de ces messages transitent en clair sur les serveurs des entreprises — Facebook Messenger, Instagram Direct, Twitter DM, Snapchat. Cela signifie que l'entreprise, ses employés, et potentiellement des pirates informatiques ou des agences gouvernementales peuvent accéder à vos conversations les plus intimes.</p>
            <p>La messagerie chiffrée de Forsure élimine complètement ce risque. Grâce au chiffrement de bout en bout, vos messages sont transformés en code illisible sur votre appareil avant d'être envoyés. Ils ne sont déchiffrés que sur l'appareil de votre correspondant. Personne d'autre — absolument personne — ne peut les lire.</p>
            <p>Ce n'est pas une simple promesse marketing. La messagerie chiffrée de Forsure utilise les mêmes protocoles de sécurité que Signal, l'application recommandée par les experts en cybersécurité du monde entier. La différence ? La messagerie chiffrée de Forsure est intégrée dans un réseau social complet — pas besoin d'application séparée.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Les risques sans messagerie chiffrée</h3>
            <p>Pour comprendre l'importance d'une messagerie chiffrée, regardons ce qui se passe sur les messageries non chiffrées :</p>
            <ul className="space-y-2">
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Vos messages peuvent être lus</strong> par l'entreprise qui héberge le service</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Vos conversations sont analysées</strong> par des algorithmes pour cibler la publicité</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">En cas de piratage</strong>, vos messages privés sont exposés en clair</li>
              <li><CheckCircle className="w-4 h-4 text-primary inline mr-2" /><strong className="text-foreground">Des gouvernements peuvent demander</strong> l'accès à vos conversations sans votre consentement</li>
            </ul>
            <p>La messagerie chiffrée de Forsure rend chacun de ces scénarios techniquement impossible.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Comment fonctionne la messagerie chiffrée de Forsure étape par étape</h2>
            <p>Le processus de chiffrement de la messagerie chiffrée est entièrement automatique et invisible pour l'utilisateur. Voici ce qui se passe en coulisses quand vous envoyez un message :</p>
            <ul className="space-y-3">
              <li>1️⃣ <strong className="text-foreground">Chiffrement sur votre appareil</strong> — La messagerie chiffrée transforme votre message en code illisible avec une clé unique que seul votre correspondant possède</li>
              <li>2️⃣ <strong className="text-foreground">Transit sécurisé</strong> — Le message voyage sur Internet sous forme chiffrée — même nos serveurs ne peuvent pas le lire</li>
              <li>3️⃣ <strong className="text-foreground">Déchiffrement chez le destinataire</strong> — La messagerie chiffrée déchiffre automatiquement le message sur l'appareil de votre correspondant</li>
              <li>4️⃣ <strong className="text-foreground">Renouvellement de la clé</strong> — La messagerie chiffrée génère une nouvelle clé pour le prochain message, renforçant encore la protection</li>
            </ul>
            <p>Ce renouvellement constant des clés dans la messagerie chiffrée signifie que même dans le scénario extrêmement improbable où une clé serait compromise, seul un message pourrait être affecté. Tous les autres restent parfaitement protégés.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">La messagerie chiffrée Forsure vs WhatsApp, Messenger et Telegram</h2>

            <h3 className="text-xl font-bold text-foreground mt-8">Messagerie chiffrée Forsure vs WhatsApp</h3>
            <p>WhatsApp prétend offrir un chiffrement de bout en bout, mais appartient à Meta (Facebook). WhatsApp collecte et partage avec Facebook vos métadonnées : qui vous contactez, quand, pendant combien de temps, depuis quelle localisation. Ces données sont utilisées pour cibler la publicité sur Facebook et Instagram. La messagerie chiffrée de Forsure ne collecte aucune de ces métadonnées.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Messagerie chiffrée Forsure vs Facebook Messenger</h3>
            <p>Facebook Messenger n'active le chiffrement de bout en bout que si vous le demandez explicitement (conversations secrètes). Par défaut, vos messages sont en clair et analysés par Facebook pour la publicité ciblée. La messagerie chiffrée de Forsure est active par défaut pour toutes les conversations, sans exception.</p>

            <h3 className="text-xl font-bold text-foreground mt-8">Messagerie chiffrée Forsure vs Telegram</h3>
            <p>Telegram ne chiffre pas les conversations de groupe et les chats normaux ne sont pas chiffrés de bout en bout. Seuls les "chats secrets" bénéficient d'un chiffrement, mais avec un protocole propriétaire non vérifié par des experts indépendants. La messagerie chiffrée de Forsure utilise des protocoles open source audités et protège toutes les conversations par défaut.</p>

            <h2 className="text-2xl font-bold text-foreground mt-10">Tout est protégé par la messagerie chiffrée, pas seulement les textes</h2>
            <p>La messagerie chiffrée de Forsure ne se limite pas aux messages texte. Chaque type de contenu que vous partagez bénéficie du même niveau de protection maximale :</p>
            <ul className="space-y-2">
              <li>📝 <strong className="text-foreground">Messages texte</strong> — Protégés par la messagerie chiffrée de bout en bout</li>
              <li>📸 <strong className="text-foreground">Photos et vidéos</strong> — Chiffrées avant l'envoi par la messagerie chiffrée</li>
              <li>🎤 <strong className="text-foreground">Messages vocaux</strong> — Protégés par le même chiffrement de la messagerie chiffrée</li>
              <li>📎 <strong className="text-foreground">Documents et fichiers</strong> — Transmis de façon sécurisée via la messagerie chiffrée</li>
              <li>📞 <strong className="text-foreground">Appels vidéo et audio</strong> — Chiffrés en temps réel par la messagerie chiffrée</li>
              <li>😄 <strong className="text-foreground">GIF et stickers</strong> — Également protégés par la messagerie chiffrée</li>
            </ul>

            <h2 className="text-2xl font-bold text-foreground mt-10">La messagerie chiffrée de Forsure : aussi simple que n'importe quelle messagerie</h2>
            <p>Le plus grand avantage de la messagerie chiffrée de Forsure, c'est sa simplicité. Vous n'avez absolument rien à configurer. Pas de clé à générer, pas de paramètre à activer, pas de mode spécial à sélectionner. La messagerie chiffrée fonctionne exactement comme n'importe quelle messagerie que vous connaissez — envoyez un message, il est protégé. C'est aussi simple que ça.</p>
            <p>La messagerie chiffrée de Forsure est intégrée dans un <Link to="/reseau-social-securise" className="text-primary hover:underline">réseau social sécurisé</Link> complet qui inclut également un <Link to="/feed-intelligent" className="text-primary hover:underline">feed intelligent sans publicité</Link>, une <Link to="/ia-moderation" className="text-primary hover:underline">intelligence artificielle de modération</Link> et une <Link to="/protection-donnees" className="text-primary hover:underline">protection complète des données personnelles</Link>.</p>

            <div className="text-center pt-8">
              <Link to="/signup"><Button size="lg" className="px-8">Essayer la messagerie chiffrée gratuitement</Button></Link>
            </div>
          </div>
        </div>
      </section>

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
