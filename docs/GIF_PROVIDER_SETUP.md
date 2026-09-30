# Activation du sélecteur GIF

Le sélecteur utilise directement les endpoints Search et Trending de GIPHY, conformément à leur règle interdisant de proxyfier les requêtes ou les médias.

## Configuration Lovable Cloud

1. Créer une clé **Web** dans le [tableau de bord développeur GIPHY](https://developers.giphy.com/dashboard/).
2. Ajouter la variable de build `VITE_GIPHY_API_KEY` dans le projet Lovable Cloud.
3. Redéployer l’application.
4. Vérifier dans le sélecteur que les GIF tendance s’affichent, qu’une recherche renvoie des résultats et qu’un GIF envoyé est relu dans la conversation.

La clé est utilisée côté navigateur, comme demandé par [la documentation officielle GIPHY](https://developers.giphy.com/docs/api/). Il faut conserver l’attribution « Powered by GIPHY » affichée dans le sélecteur et demander une clé de production avant une montée en charge importante.

Sans cette variable, l’interface échoue volontairement en mode fermé et n’envoie aucune requête vers un fournisseur non configuré.
