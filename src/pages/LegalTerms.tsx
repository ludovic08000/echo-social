import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { SEOHead } from '@/components/SEOHead';

export default function LegalTerms() {
  return (
    <div className="min-h-screen bg-background">
      <SEOHead
        title="Conditions Générales d'Utilisation"
        description="Conditions générales d'utilisation de Forsure, réseau social éthique français. Mentions légales, droits et obligations des utilisateurs."
        url="https://forsure.fans/legal"
        noindex
      />
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link to="/signup">
          <Button variant="ghost" size="sm" className="mb-6">
            <ArrowLeft className="w-4 h-4 mr-2" /> Retour
          </Button>
        </Link>

        <h1 className="text-3xl font-bold mb-8">Conditions Générales d'Utilisation</h1>
        <p className="text-sm text-muted-foreground mb-6">Dernière mise à jour : 26 octobre 2026</p>

        <div className="prose prose-invert max-w-none space-y-6 text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 1 — Mentions légales</h2>
            <p>Le site <strong>Forsure</strong> est édité conformément à la loi française. Conformément à l'article 6 de la loi n° 2004-575 du 21 juin 2004 pour la confiance dans l'économie numérique (LCEN), les informations relatives à l'éditeur sont disponibles sur cette page.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 2 — Objet</h2>
            <p>Les présentes CGU ont pour objet de définir les conditions d'accès et d'utilisation de la plateforme Forsure, réseau social accessible via le web et les applications mobiles.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 3 — Inscription</h2>
            <p>L'inscription est gratuite et l'âge minimum annoncé par le service est de 13 ans. Les conditions du consentement d'un mineur varient selon le pays et le traitement ; cet âge ne constitue pas une autorisation générale de tous les traitements. L'utilisateur s'engage à fournir des informations exactes.</p>
            <p>L'inscription inclut une <strong>vérification du domaine e-mail</strong> (MX check), une protection anti-bot et une politique de mot de passe stricte (10 caractères minimum, complexité requise). L'adresse e-mail doit être confirmée avant toute utilisation du service.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 4 — Protection des données personnelles (RGPD)</h2>
            <p>Conformément au RGPD (Règlement UE 2016/679) et à la loi Informatique et Libertés, Forsure s'engage à :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Ne collecter que les données strictement nécessaires au fonctionnement du service</li>
              <li><strong>Ne jamais vendre ni transmettre vos données à des tiers</strong> à des fins commerciales ou publicitaires</li>
              <li>Ne procéder à <strong>aucun tracking publicitaire</strong></li>
              <li>Permettre à tout moment l'exercice de vos droits : accès, rectification, effacement (droit à l'oubli), portabilité, opposition et limitation du traitement</li>
              <li>Traiter les demandes d'effacement et suivre séparément les médias, sauvegardes et données soumis à une conservation légale</li>
            </ul>
            <p>Pour exercer vos droits, contactez-nous à : <strong>dpo@forsure.fans</strong></p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 5 — Données collectées</h2>
            <p>Les données collectées sont :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Nom, adresse e-mail (inscription)</li>
              <li>Contenus publiés (textes, images, vidéos)</li>
              <li>Données de connexion (adresse IP, journaux) utilisées pour la sécurité, avec des durées adaptées à leur finalité et aux obligations applicables</li>
              <li>Empreintes d'appareil (à des fins exclusivement anti-fraude)</li>
              <li>Clés publiques cryptographiques (pour le chiffrement de bout en bout)</li>
            </ul>
            <p>Base légale : consentement (Art. 6.1.a RGPD) et exécution du contrat (Art. 6.1.b RGPD).</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 6 — Stockage dans le navigateur</h2>
            <p>La session web est conservée dans <strong>localStorage</strong>, accessible au JavaScript du site, et non dans un cookie d'authentification HttpOnly. Les préférences et le coffre chiffré utilisent aussi les stockages locaux du navigateur. Effacer ces stockages peut faire perdre des données locales si leur sauvegarde et leur restauration n'ont pas été vérifiées. Les traitements facultatifs et les lecteurs partenaires sont décrits dans la <Link to="/privacy" className="text-primary underline">politique de confidentialité</Link>.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 7 — Contenu utilisateur</h2>
            <p>L'utilisateur reste propriétaire de ses contenus. En publiant sur Forsure, il accorde une licence non-exclusive et révocable d'affichage sur la plateforme. Tout contenu illicite au regard de la loi française (incitation à la haine, diffamation, contenu à caractère pédopornographique, etc.) est strictement interdit et sera signalé aux autorités compétentes conformément à l'article 6-I-7 de la LCEN.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 8 — Modération</h2>
            <p>La modération est transparente. Aucun shadow banning n'est pratiqué. En cas de suppression de contenu, l'utilisateur est notifié avec le motif. La modération peut être assistée par intelligence artificielle (système auto-apprenant), avec possibilité de recours humain systématique.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 9 — Sécurité des communications</h2>
            <p>Les messages privés en conversation 1-à-1 bénéficient d'un <strong>chiffrement de bout en bout (E2EE)</strong> assuré par Libsignal avec PQXDH + Double Ratchet. La sauvegarde de continuité peut transmettre un coffre contenant les clés sous forme chiffrée, pas les clés en clair. L'accès à la messagerie peut être protégé par un code PIN dédié.</p>
            <p>L'architecture est conçue pour être <strong>prête pour le post-quantique</strong> (PQXDH).</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 10 — Protection de la plateforme</h2>
            <p>Forsure met en œuvre des mesures de sécurité avancées :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Protection DDoS avec rate limiting adaptatif et pénalités progressives</li>
              <li>Monitoring de sécurité IA continu avec alertes d'intrusion en temps réel</li>
              <li>Score de confiance (Trust Score) pour la détection des comportements suspects</li>
              <li>Système de bannissement multi-niveaux (utilisateur, e-mail, IP)</li>
              <li>Détection d'usurpation d'identité avec archivage légal des preuves numériques</li>
              <li>Politique de sécurité du contenu (CSP) stricte</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 11 — Suppression de compte</h2>
            <p>Tout utilisateur peut demander la suppression de son compte depuis les paramètres ou auprès de dpo@forsure.fans. La fermeture du compte ne prouve pas l'effacement immédiat de toutes les copies : les médias externes, sauvegardes et éventuelles conservations légales font l'objet d'un suivi distinct. Les copies déjà reçues par d'autres utilisateurs ne peuvent pas toutes être effacées à distance.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 12 — Responsabilité</h2>
            <p>Forsure ne saurait être tenu responsable des contenus publiés par les utilisateurs, conformément au régime de responsabilité des hébergeurs prévu par la LCEN (Art. 6-I-2). La plateforme agit promptement pour retirer les contenus manifestement illicites dès notification.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 13 — Droit applicable et juridiction</h2>
            <p>Les présentes CGU sont régies par le droit français. En cas de litige, les parties s'engagent à rechercher une solution amiable. À défaut, les tribunaux français compétents seront saisis conformément aux règles de droit commun.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 14 — CNIL</h2>
            <p>Vous avez le droit d'introduire une réclamation auprès de la Commission Nationale de l'Informatique et des Libertés (CNIL) — <a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">www.cnil.fr</a></p>
          </section>
        </div>
      </div>
    </div>
  );
}
