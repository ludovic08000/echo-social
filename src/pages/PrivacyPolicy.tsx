import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link to="/signup">
          <Button variant="ghost" size="sm" className="mb-6">
            <ArrowLeft className="w-4 h-4 mr-2" /> Retour
          </Button>
        </Link>

        <h1 className="text-3xl font-bold mb-8">Politique de Confidentialité</h1>
        <p className="text-sm text-muted-foreground mb-6">Dernière mise à jour : 10 février 2026</p>

        <div className="prose prose-invert max-w-none space-y-6 text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold text-foreground">1. Responsable du traitement</h2>
            <p>Le responsable du traitement des données est l'éditeur de <strong>Forsure.fans</strong>. Contact DPO : <strong>dpo@forsure.fans</strong></p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">2. Engagement éthique</h2>
            <p>Forsure.fans est un réseau social <strong>anti-surveillance</strong>. Nous nous engageons formellement à :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>🚫 <strong>Aucune revente de données</strong> à des tiers</li>
              <li>🚫 <strong>Aucun tracking publicitaire</strong></li>
              <li>🚫 <strong>Aucun profilage commercial</strong></li>
              <li>✅ Transparence totale sur les données collectées</li>
              <li>✅ Suppression immédiate sur demande</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">3. Données collectées</h2>
            <p>Nous collectons uniquement les données nécessaires au fonctionnement du service :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Données d'identification</strong> : nom d'affichage, adresse e-mail</li>
              <li><strong>Contenus</strong> : textes, images, vidéos publiés volontairement</li>
              <li><strong>Données techniques</strong> : adresse IP, user-agent (conservés selon les obligations légales)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">4. Base légale du traitement</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Consentement</strong> (Art. 6.1.a RGPD) : acceptation des CGU lors de l'inscription</li>
              <li><strong>Exécution du contrat</strong> (Art. 6.1.b RGPD) : fourniture du service</li>
              <li><strong>Obligation légale</strong> (Art. 6.1.c RGPD) : conservation des logs de connexion</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">5. Durée de conservation</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>Données de compte : durée de l'inscription + 30 jours après suppression</li>
              <li>Logs de connexion : 12 mois (obligation légale LCEN)</li>
              <li>Contenus supprimés : effacés sous 30 jours</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">6. Vos droits (RGPD)</h2>
            <p>Conformément aux articles 15 à 22 du RGPD, vous disposez des droits suivants :</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Droit d'accès</strong> : obtenir une copie de vos données</li>
              <li><strong>Droit de rectification</strong> : corriger vos informations</li>
              <li><strong>Droit à l'effacement</strong> : supprimer votre compte et toutes vos données</li>
              <li><strong>Droit à la portabilité</strong> : exporter vos données dans un format lisible</li>
              <li><strong>Droit d'opposition</strong> : vous opposer au traitement</li>
              <li><strong>Droit à la limitation</strong> : limiter le traitement de vos données</li>
            </ul>
            <p>Ces droits sont exercables directement dans les paramètres de votre compte ou par email à <strong>dpo@forsure.fans</strong>.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">7. Transferts de données</h2>
            <p>Les données sont hébergées au sein de l'Union Européenne. Aucun transfert hors UE n'est effectué sans garanties appropriées (clauses contractuelles types, Art. 46 RGPD).</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">8. Sécurité</h2>
            <p>Nous mettons en œuvre des mesures techniques et organisationnelles conformes à l'état de l'art : chiffrement des données en transit (TLS), authentification sécurisée, contrôle d'accès par rôles (RLS).</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">9. Réclamation</h2>
            <p>Vous pouvez introduire une réclamation auprès de la <strong>CNIL</strong> : <a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">www.cnil.fr</a></p>
          </section>
        </div>
      </div>
    </div>
  );
}
