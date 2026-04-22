import { ArrowLeft, Shield, Lock, Eye, Trash2, Download, UserCheck, Bell, Brain, ShoppingBag, Video, MessageSquare, Gamepad2, Fingerprint, Radar, KeyRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { SEOHead } from '@/components/SEOHead';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background">
      <SEOHead
        title="Politique de Confidentialité"
        description="Politique de confidentialité Forsure : zéro revente de données, conformité RGPD, chiffrement bout en bout. Vos données personnelles restent les vôtres."
        url="https://forsure.fans/privacy"
        noindex
      />
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link to="/">
          <Button variant="ghost" size="sm" className="mb-6">
            <ArrowLeft className="w-4 h-4 mr-2" /> Retour à l'accueil
          </Button>
        </Link>

        <div className="flex items-center gap-3 mb-4">
          <Shield className="w-8 h-8 text-primary" />
          <h1 className="text-3xl font-bold">Politique de Confidentialité</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-8">Dernière mise à jour : 3 avril 2026</p>

        <div className="prose prose-invert max-w-none space-y-8 text-foreground/90">

          {/* 1. Responsable */}
          <section>
            <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <UserCheck className="w-5 h-5 text-primary" /> 1. Responsable du traitement
            </h2>
            <p>Le responsable du traitement des données est l'éditeur de <strong>Forsure</strong>, réseau social éthique accessible sur <strong>forsure.fans</strong>.</p>
            <p>Contact DPO (Délégué à la Protection des Données) : <strong>dpo@forsure.fans</strong></p>
          </section>

          {/* 2. Engagement éthique */}
          <section>
            <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Lock className="w-5 h-5 text-primary" /> 2. Notre engagement éthique
            </h2>
            <p>Forsure est un réseau social <strong>anti-surveillance</strong>. Nous nous engageons formellement à :</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>🚫 <strong>Aucune revente de données</strong> à des tiers, annonceurs ou courtiers de données</li>
              <li>🚫 <strong>Aucun tracking publicitaire</strong> — aucun pixel espion, aucun cookie tiers</li>
              <li>🚫 <strong>Aucun profilage commercial</strong> — votre comportement n'est jamais analysé à des fins marketing</li>
              <li>🚫 <strong>Aucun shadow banning</strong> — si un contenu est modéré, vous êtes notifié avec le motif</li>
              <li>✅ <strong>Transparence totale</strong> sur les données collectées et leur usage</li>
              <li>✅ <strong>Suppression immédiate</strong> de vos données sur simple demande</li>
              <li>✅ <strong>Adresses e-mail masquées</strong> dans l'interface (ex : jo***@gmail.com) pour renforcer votre vie privée</li>
            </ul>
          </section>

          {/* 3. Données collectées */}
          <section>
            <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Eye className="w-5 h-5 text-primary" /> 3. Données collectées
            </h2>
            <p>Nous collectons uniquement les données <strong>strictement nécessaires</strong> au fonctionnement du service :</p>

            <h3 className="text-lg font-medium text-foreground mt-4">3.1. Données d'identification</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Nom d'affichage, adresse e-mail (lors de l'inscription par e-mail ou via Google)</li>
              <li>Photo de profil, biographie, ville (optionnels, renseignés par vous)</li>
              <li>Date de naissance (pour la vérification d'âge et la protection des mineurs)</li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4">3.2. Contenus publiés</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Publications (textes, images, vidéos) dans le fil d'actualité</li>
              <li>Stories éphémères</li>
              <li>Albums photo</li>
              <li>Messages privés et conversations de groupe</li>
              <li>Messages vocaux</li>
              <li>Commentaires et réactions</li>
              <li>Publications dans les groupes et pages</li>
              <li>Messages sur le mur anonyme</li>
              <li>Entrées de journal intime (privées, visibles uniquement par vous)</li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4">3.3. Données Marketplace</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Produits mis en vente (titre, description, prix, images)</li>
              <li>Commandes et historique d'achats</li>
              <li>Avis et évaluations vendeur</li>
              <li>Négociations de prix</li>
              <li>Adresses de livraison (traitées par le prestataire de paiement Stripe)</li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4">3.4. Données de live streaming</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Diffusions en direct et métadonnées (titre, catégorie, durée)</li>
              <li>Messages du chat en direct</li>
              <li>Statistiques de visionnage (nombre de spectateurs)</li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4">3.5. Données techniques et de sécurité</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Adresse IP et logs de connexion (obligation légale LCEN — conservés 12 mois)</li>
              <li>User-agent du navigateur</li>
              <li>Empreinte de l'appareil (à des fins exclusivement anti-fraude, pour détecter les usurpations d'identité et comptes multiples abusifs)</li>
              <li>Clés publiques cryptographiques (pour le chiffrement de bout en bout des messages)</li>
            </ul>
          </section>

          {/* 4. Fonctionnalités et usage des données */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">4. Fonctionnalités et usage des données</h2>

            <h3 className="text-lg font-medium text-foreground mt-4 flex items-center gap-2">
              <Brain className="w-4 h-4 text-primary" /> 4.1. Intelligence artificielle (Zeus & Agents IA)
            </h3>
            <p>Forsure intègre un assistant IA (<strong>Zeus</strong>), des agents IA spécialisés, ainsi qu'un <strong>moteur IA de sécurité auto-apprenant</strong>. Ces outils :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Utilisent vos messages <strong>uniquement dans le cadre de votre conversation</strong></li>
              <li>Ne stockent <strong>aucun historique</strong> à des fins d'entraînement de modèles tiers</li>
              <li>Aident à la modération de contenu de manière transparente avec possibilité de recours humain</li>
              <li>L'assistant IA vendeur (coach) analyse uniquement les données de votre boutique pour vous conseiller</li>
              <li>Le moteur IA de sécurité détecte les menaces (DDoS, intrusions, abus) et génère des rapports d'incidents automatisés, sans analyser vos contenus personnels</li>
              <li>L'IA apprend localement des patterns de menaces pour réduire la dépendance aux services tiers, <strong>sans utiliser de données utilisateurs</strong></li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" /> 4.2. Messagerie et appels
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Chiffrement de bout en bout (E2EE)</strong> pour les conversations privées 1-à-1 via le protocole <strong>X3DH + Double Ratchet</strong> (standard Signal)</li>
              <li>Les clés privées ne quittent <strong>jamais votre appareil</strong> — Forsure ne peut pas lire vos messages chiffrés</li>
              <li>Vérification d'identité cryptographique par empreinte de clé (fingerprint) pour détecter les changements d'appareil</li>
              <li>Protection d'accès à la messagerie par <strong>code PIN dédié</strong> (hachage PBKDF2 côté serveur)</li>
              <li>Les appels audio/vidéo transitent par une infrastructure sécurisée (LiveKit)</li>
              <li>Un système anti-spam analyse les métadonnées pour détecter les abus, <strong>sans lire le contenu des messages chiffrés</strong></li>
              <li>Vous pouvez supprimer vos messages à tout moment</li>
              <li>Sauvegarde chiffrée des clés E2EE avec transfert sécurisé entre appareils via QR code</li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4 flex items-center gap-2">
              <ShoppingBag className="w-4 h-4 text-primary" /> 4.3. Marketplace et paiements
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Les paiements sont traités exclusivement par <strong>Stripe</strong> — Forsure ne stocke aucune donnée bancaire</li>
              <li>Les abonnements créateur transitent par Stripe</li>
              <li>Les pourboires (tips) sont gérés via Stripe</li>
              <li>Les vidéos de preuve d'emballage sont stockées de manière sécurisée</li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4 flex items-center gap-2">
              <Video className="w-4 h-4 text-primary" /> 4.4. Fil d'actualité et algorithme
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>L'algorithme de recommandation est basé sur vos <strong>interactions sociales</strong> (amis, likes), pas sur un profilage commercial</li>
              <li>Vous pouvez consulter les facteurs de scoring de chaque publication</li>
              <li>Aucun contenu sponsorisé caché — les publicités sont clairement identifiées</li>
              <li>L'algorithme est optimisé par une IA de feed avec des recommandations transparentes et réversibles</li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4 flex items-center gap-2">
              <Gamepad2 className="w-4 h-4 text-primary" /> 4.5. Jeux et défis
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Les jeux intégrés (échecs, dames, morpion, etc.) ne collectent aucune donnée supplémentaire</li>
              <li>Les défis communautaires stockent uniquement vos participations et soumissions</li>
            </ul>
          </section>

          {/* 5. Protection des mineurs */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">5. Protection des mineurs</h2>
            <p>Forsure accorde une importance particulière à la <strong>protection des utilisateurs de moins de 18 ans</strong> :</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Vérification d'âge obligatoire à l'inscription (13 ans minimum, conformément au RGPD)</li>
              <li>Système de <strong>contrôle parental</strong> avec code PIN sécurisé (8-12 caractères, hachage serveur) configurable par les parents</li>
              <li>Filtrage de contenu par catégories autorisées (éducation, sport, gaming, musique, art, humour)</li>
              <li>Restrictions automatiques pour les mineurs : <strong>seuls les amis approuvés</strong> peuvent envoyer des messages</li>
              <li>Badge « mineur protégé » visible pour sensibiliser les autres utilisateurs</li>
              <li>Bouton de signalement spécifique pour les interactions impliquant un mineur</li>
              <li>Fonctionnalités de <strong>bien-être numérique</strong> : détox programmée, rappels de pause, limite de temps quotidienne</li>
            </ul>
          </section>

          {/* 6. Base légale */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">6. Base légale du traitement</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Consentement</strong> (Art. 6.1.a RGPD) : acceptation des CGU lors de l'inscription</li>
              <li><strong>Exécution du contrat</strong> (Art. 6.1.b RGPD) : fourniture du service, marketplace</li>
              <li><strong>Obligation légale</strong> (Art. 6.1.c RGPD) : conservation des logs de connexion (LCEN)</li>
              <li><strong>Intérêt légitime</strong> (Art. 6.1.f RGPD) : sécurité anti-fraude, détection d'usurpation d'identité, protection DDoS</li>
            </ul>
          </section>

          {/* 7. Durée de conservation */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">7. Durée de conservation</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>Données de compte : durée de l'inscription + 30 jours après suppression</li>
              <li>Logs de connexion et empreintes d'appareil : <strong>12 mois</strong> (obligation légale LCEN)</li>
              <li>Contenus supprimés : effacés sous 30 jours via processus automatisé</li>
              <li>Clés cryptographiques : supprimées avec le compte</li>
              <li>Données de commande marketplace : conformément aux obligations comptables légales</li>
              <li>Archives d'usurpation d'identité : conservées à des fins de prévention et obligations légales</li>
              <li>Patterns de sécurité IA : conservés de manière anonymisée (aucune donnée personnelle)</li>
            </ul>
          </section>

          {/* 8. Cookies */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">8. Cookies</h2>
            <p>Forsure utilise <strong>uniquement des cookies techniques</strong> strictement nécessaires :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Cookie d'authentification (session utilisateur) — <strong>Secure, HttpOnly, SameSite=Strict</strong></li>
              <li>Préférences d'affichage (thème clair/sombre, langue)</li>
            </ul>
            <p className="font-semibold mt-2">🚫 Aucun cookie publicitaire, aucun cookie de traçage, aucun cookie tiers.</p>
            <p className="text-sm text-muted-foreground">Conformément à la directive ePrivacy et aux recommandations de la CNIL.</p>
          </section>

          {/* 9. Vos droits */}
          <section>
            <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Download className="w-5 h-5 text-primary" /> 9. Vos droits (RGPD)
            </h2>
            <p>Conformément aux articles 15 à 22 du RGPD, vous disposez des droits suivants :</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Droit d'accès</strong> : obtenir une copie de vos données</li>
              <li><strong>Droit de rectification</strong> : corriger vos informations dans les paramètres</li>
              <li><strong>Droit à l'effacement</strong> : supprimer votre compte et toutes vos données</li>
              <li><strong>Droit à la portabilité</strong> : exporter vos données dans un format lisible (fonctionnalité intégrée dans les paramètres)</li>
              <li><strong>Droit d'opposition</strong> : vous opposer au traitement</li>
              <li><strong>Droit à la limitation</strong> : limiter le traitement de vos données</li>
            </ul>
            <div className="bg-muted/50 border border-border rounded-lg p-4 mt-4">
              <p className="font-medium">📋 Comment exercer vos droits :</p>
              <ul className="list-disc pl-6 space-y-1 mt-2">
                <li><strong>Export de données</strong> : Paramètres → Gestion du compte → Exporter mes données</li>
                <li><strong>Suppression de compte</strong> : Paramètres → Gestion du compte → Supprimer mon compte</li>
                <li><strong>Par e-mail</strong> : <a href="mailto:dpo@forsure.fans" className="text-primary hover:underline">dpo@forsure.fans</a></li>
              </ul>
            </div>
          </section>

          {/* 10. Sécurité */}
          <section>
            <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" /> 10. Sécurité des données
            </h2>
            <p>Nous mettons en œuvre des mesures techniques et organisationnelles conformes à l'état de l'art :</p>

            <h3 className="text-lg font-medium text-foreground mt-4 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-primary" /> 10.1. Chiffrement
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Chiffrement de bout en bout (E2EE)</strong> des messages privés via X3DH + Double Ratchet (protocole Signal)</li>
              <li>Architecture <strong>prête pour le post-quantique</strong> (PQXDH)</li>
              <li>Chiffrement des données en transit (TLS/HTTPS)</li>
              <li>Sauvegarde chiffrée des clés avec transfert sécurisé entre appareils</li>
              <li>Hachage des codes PIN via PBKDF2 côté serveur</li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4 flex items-center gap-2">
              <Fingerprint className="w-4 h-4 text-primary" /> 10.2. Authentification et accès
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Authentification sécurisée avec <strong>vérification e-mail obligatoire</strong> (domaine MX vérifié)</li>
              <li>Politique de mot de passe stricte (10 caractères minimum, score de complexité 3/4, blacklist)</li>
              <li>Protection anti-bot à l'inscription (honeypot, délai de soumission 3s)</li>
              <li>Connexion via Google OAuth 2.0 disponible</li>
              <li>Gardien de session : déconnexion automatique après 30 min d'inactivité ou changement d'appareil</li>
              <li>URLs de redirection sécurisées via whitelist de domaines contrôlés</li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4 flex items-center gap-2">
              <Radar className="w-4 h-4 text-primary" /> 10.3. Protection de la plateforme
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Protection DDoS</strong> avec rate limiting adaptatif et pénalités progressives</li>
              <li>Contrôle d'accès par rôles (Row Level Security)</li>
              <li>Système de <strong>score de confiance</strong> (Trust Score 0-100) pour détecter les comportements suspects</li>
              <li>Détection automatique d'usurpation d'identité avec archivage légal des preuves</li>
              <li>Système de bannissement multi-niveaux (utilisateur, e-mail, IP) en cas d'abus</li>
              <li>Modération IA avec feedback humain et <strong>règles auto-apprises</strong></li>
              <li>Protection anti-capture d'écran sur les contenus sensibles (photos protégées)</li>
              <li><strong>IA SOC (Security Operations Center)</strong> : monitoring continu, analyse des menaces et alertes d'intrusion en temps réel</li>
              <li>Anti-spam : rate limiting par action (30 msg/min max), détection de doublons, cooldown entre envois</li>
              <li>Politique de sécurité du contenu (CSP) stricte interdisant l'exécution de scripts non autorisés</li>
            </ul>
          </section>

          {/* 11. Publicités */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">11. Publicités éthiques</h2>
            <p>Forsure propose un système publicitaire <strong>respectueux de votre vie privée</strong> :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Les publicités sont clairement identifiées comme « sponsorisées »</li>
              <li>Le ciblage est basé sur des critères généraux (âge, localisation, centres d'intérêt déclarés) et jamais sur un profilage comportemental</li>
              <li>Chaque campagne publicitaire est soumise à une modération avant diffusion</li>
              <li>Vous ne verrez jamais de publicité basée sur vos messages privés ou conversations</li>
            </ul>
          </section>

          {/* 12. Transferts */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">12. Transferts de données</h2>
            <p>Les données sont hébergées au sein de l'Union Européenne. Les fichiers médias (photos, vidéos) sont stockés sur une infrastructure cloud sécurisée (Cloudflare R2).</p>
            <p>Aucun transfert hors UE n'est effectué sans garanties appropriées (clauses contractuelles types, Art. 46 RGPD).</p>
          </section>

          {/* 13. Sous-traitants */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">13. Sous-traitants</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Stripe</strong> : traitement des paiements (marketplace, abonnements, pourboires)</li>
              <li><strong>Cloudflare R2</strong> : stockage sécurisé des fichiers médias</li>
              <li><strong>LiveKit</strong> : infrastructure d'appels audio/vidéo en temps réel</li>
              <li><strong>Google</strong> : authentification OAuth (si vous choisissez la connexion Google)</li>
            </ul>
            <p className="mt-2">Chaque sous-traitant est soumis à des engagements contractuels conformes au RGPD (Art. 28).</p>
          </section>

          {/* 14. Notifications */}
          <section>
            <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Bell className="w-5 h-5 text-primary" /> 14. Notifications et préférences
            </h2>
            <p>Vous avez un contrôle total sur les notifications :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Paramétrage granulaire (likes, commentaires, messages, demandes d'amis, stories, etc.)</li>
              <li>Choix des sons de notification</li>
              <li>Activation/désactivation des notifications e-mail avec lien de désinscription dans chaque e-mail</li>
              <li>Paramètres de confidentialité configurables (qui peut voir votre profil, vos publications, statut en ligne, etc.)</li>
              <li>Gestion des amis restreints</li>
              <li>Mode fantôme (ghost mode) pour naviguer de manière invisible</li>
            </ul>
          </section>

          {/* 15. Onboarding sécurisé */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">15. Processus d'inscription sécurisé</h2>
            <p>L'inscription sur Forsure suit un processus contrôlé :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Vérification du domaine e-mail (MX check) avant envoi du lien de confirmation</li>
              <li>Protection anti-bot (honeypot, délai minimal de 3 secondes)</li>
              <li>Données temporaires protégées par signature HMAC-SHA256 (le mot de passe brut n'est jamais stocké côté client)</li>
              <li>Progression d'onboarding verrouillée côté serveur</li>
              <li>Confirmation e-mail avec attente active de la session (pas de délai arbitraire)</li>
            </ul>
          </section>

          {/* 16. Modification */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">16. Modification de cette politique</h2>
            <p>Nous nous réservons le droit de modifier cette politique. En cas de changement substantiel, vous serez informé via une notification dans l'application. La date de dernière mise à jour figure en haut de cette page.</p>
          </section>

          {/* 17. Réclamation */}
          <section>
            <h2 className="text-xl font-semibold text-foreground">17. Réclamation</h2>
            <p>Vous pouvez introduire une réclamation auprès de la <strong>Commission Nationale de l'Informatique et des Libertés (CNIL)</strong> :</p>
            <p><a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-medium">🔗 www.cnil.fr</a></p>
          </section>
        </div>

        {/* Footer */}
        <div className="mt-12 pt-6 border-t border-border text-center text-sm text-muted-foreground">
          <p>© {new Date().getFullYear()} Forsure — Réseau social éthique</p>
          <p className="mt-1">Contact DPO : <a href="mailto:dpo@forsure.fans" className="text-primary hover:underline">dpo@forsure.fans</a></p>
          <div className="flex justify-center gap-4 mt-3">
            <Link to="/legal" className="text-primary hover:underline">CGU</Link>
            <Link to="/" className="text-primary hover:underline">Accueil</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
