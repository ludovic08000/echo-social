import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function LegalTerms() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link to="/signup">
          <Button variant="ghost" size="sm" className="mb-6">
            <ArrowLeft className="w-4 h-4 mr-2" /> Retour
          </Button>
        </Link>

        <h1 className="text-3xl font-bold mb-8">Conditions Générales d'Utilisation</h1>
        <p className="text-sm text-muted-foreground mb-6">Dernière mise à jour : 10 février 2026</p>

        <div className="prose prose-invert max-w-none space-y-6 text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 1 — Mentions légales</h2>
            <p>Le site <strong>Forsure.fans</strong> est édité conformément à la loi française. Conformément à l'article 6 de la loi n° 2004-575 du 21 juin 2004 pour la confiance dans l'économie numérique (LCEN), les informations relatives à l'éditeur sont disponibles sur cette page.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 2 — Objet</h2>
            <p>Les présentes CGU ont pour objet de définir les conditions d'accès et d'utilisation de la plateforme Forsure.fans, réseau social accessible via le web et les applications mobiles.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 3 — Inscription</h2>
            <p>L'inscription est gratuite et ouverte à toute personne physique âgée d'au moins 13 ans, conformément au Règlement Général sur la Protection des Données (RGPD) et à la loi n° 78-17 du 6 janvier 1978 relative à l'informatique, aux fichiers et aux libertés. L'utilisateur s'engage à fournir des informations exactes.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 4 — Protection des données personnelles (RGPD)</h2>
            <p>Conformément au RGPD (Règlement UE 2016/679) et à la loi Informatique et Libertés, Forsure.fans s'engage à :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Ne collecter que les données strictement nécessaires au fonctionnement du service</li>
              <li><strong>Ne jamais vendre ni transmettre vos données à des tiers</strong> à des fins commerciales ou publicitaires</li>
              <li>Ne procéder à <strong>aucun tracking publicitaire</strong></li>
              <li>Permettre à tout moment l'exercice de vos droits : accès, rectification, effacement (droit à l'oubli), portabilité, opposition et limitation du traitement</li>
              <li>Supprimer vos données dans un délai de 30 jours après suppression du compte</li>
            </ul>
            <p>Pour exercer vos droits, contactez-nous à : <strong>dpo@forsure.fans</strong></p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 5 — Données collectées</h2>
            <p>Les données collectées sont :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Nom, adresse e-mail (inscription)</li>
              <li>Contenus publiés (textes, images, vidéos)</li>
              <li>Données de connexion (adresse IP, logs) conservées conformément à la loi</li>
            </ul>
            <p>Base légale : consentement (Art. 6.1.a RGPD) et exécution du contrat (Art. 6.1.b RGPD).</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 6 — Cookies</h2>
            <p>Forsure.fans utilise uniquement des cookies techniques strictement nécessaires au fonctionnement du service (authentification, session). Aucun cookie publicitaire ou de traçage n'est utilisé, conformément à la directive ePrivacy et aux recommandations de la CNIL.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 7 — Contenu utilisateur</h2>
            <p>L'utilisateur reste propriétaire de ses contenus. En publiant sur Forsure.fans, il accorde une licence non-exclusive et révocable d'affichage sur la plateforme. Tout contenu illicite au regard de la loi française (incitation à la haine, diffamation, contenu à caractère pédopornographique, etc.) est strictement interdit et sera signalé aux autorités compétentes conformément à l'article 6-I-7 de la LCEN.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 8 — Modération</h2>
            <p>La modération est transparente. Aucun shadow banning n'est pratiqué. En cas de suppression de contenu, l'utilisateur est notifié avec le motif. La modération peut être assistée par intelligence artificielle, avec possibilité de recours humain.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 9 — Suppression de compte</h2>
            <p>Conformément au RGPD (Art. 17 — Droit à l'effacement), tout utilisateur peut demander la suppression de son compte et de l'ensemble de ses données personnelles. La suppression est effective immédiatement et les données sont purgées sous 30 jours.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 10 — Responsabilité</h2>
            <p>Forsure.fans ne saurait être tenu responsable des contenus publiés par les utilisateurs, conformément au régime de responsabilité des hébergeurs prévu par la LCEN (Art. 6-I-2). La plateforme agit promptement pour retirer les contenus manifestement illicites dès notification.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 11 — Droit applicable et juridiction</h2>
            <p>Les présentes CGU sont régies par le droit français. En cas de litige, les parties s'engagent à rechercher une solution amiable. À défaut, les tribunaux français compétents seront saisis conformément aux règles de droit commun.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">Article 12 — CNIL</h2>
            <p>Vous avez le droit d'introduire une réclamation auprès de la Commission Nationale de l'Informatique et des Libertés (CNIL) — <a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">www.cnil.fr</a></p>
          </section>
        </div>
      </div>
    </div>
  );
}
