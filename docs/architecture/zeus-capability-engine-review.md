# Revue du moteur de capacités Zeus — 9 novembre 2026

Ce rapport décrit l’état initial. Le raccordement effectué le 10 novembre et les preuves actuelles sont documentés dans [la release du moteur](../releases/2026-11-10-zeus-engine-wiring.md). La validation locale ne constitue pas une publication dans Lovable Cloud.

## Périmètre

Revue du code local `zeusCapabilities.ts`, `zeusCommands.ts`, `useZeusCommands.ts`, `ZeusCompanion.tsx`, `zeusFriendRequests.ts`, `agent-chat`, `agent-actions` et de la migration d'activité/rétention. Le moteur Python du feed (`ml/feed_ai`) est un autre composant et n'est pas l'objet de cette revue. L'état du code local n'est pas une preuve de déploiement.

## Constats

1. **Registre non appliqué à l'exécution.** `capabilityForCommand` et `ZEUS_CAPABILITIES` ne sont appelés que par leurs tests, pas par `useZeusCommands` ou `ZeusCompanion`. Les propriétés `userScoped` et `requiresConfirmation` décrivent l'intention ; elles n'imposent pas à elles seules une permission serveur.
2. **Actions reconnues mais non raccordées.** Le schéma et le parseur acceptent `list_friend_requests`, `show_friend_request_profile`, `respond_friend_request` et `update_feed_appearance`. Leur traitement manque dans `preparePendingAction` et `executeAction` : elles peuvent arriver au fallback `agent-actions`, qui ne prend en charge que publication, planification, story et génération d'image. La fonction de réponse aux demandes d'amis existe côté SQL et possède un test par rôle, mais son helper frontend n'est utilisé que dans ses tests.
3. **Politique administrateur prévue, non implémentée.** Le document d'architecture décrit activation par capacité, rôle et abonnement, avec version et audit. Aucun chargement ni contrôle de cette politique n'est présent dans le parcours étudié. Le contrôle serveur existant du droit aux commandes vocales reste séparé.
4. **Idempotence limitée au client.** Le `Map` de `useZeusCommands` évite les confirmations concurrentes dans une instance. Il ne constitue pas un registre serveur durable de commandes. Le document cible doit distinguer cette protection locale d'une garantie commune aux rechargements et onglets. Les garanties propres aux transports existants restent applicables.
5. **Écart de schéma SQL corrigé localement.** `friendships.status` est `public.friendship_status`, pas du texte. La conversion explicite a été ajoutée et le test PostgreSQL utilise désormais ce type enum, avec refus d'une demande étrangère et d'une seconde réponse à une demande déjà traitée.

## Éléments présents

Le registre explicite les domaines, le risque et la confirmation. Les schémas refusent les paramètres manquants et les valeurs d'apparence hors liste autorisée. Les commandes déjà raccordées de message, appel et publication utilisent les parcours existants. La résolution de destinataires refuse de choisir arbitrairement entre homonymes. Les comptes réels d'activité sont lus par une RPC liée au compte authentifié.

## Séquence pour terminer ce moteur

1. Utiliser le registre comme source commune du parseur, de l'interface et de l'exécuteur, avec rejet explicite des capacités reconnues mais non disponibles. Conserver la validation serveur spécifique de chaque action.
2. Appliquer les politiques de capacités côté serveur sans possibilité d'abaisser le minimum de confirmation défini dans le code.
3. Raccorder les quatre commandes restantes à leurs fonctions existantes, résoudre les personnes depuis les données visibles du compte et tester les parcours complets, pas seulement les helpers isolés.
4. Ajouter un reçu de commande durable avec identité, expiration et clé d'idempotence pour les actions concernées, en conservant Aegis/Libsignal et leurs garanties.
5. Activer progressivement et vérifier l'état réellement servi. Les tâches de purge et la lecture vocale ont leurs contrôles séparés dans le document de release du 9 novembre.

**Conclusion :** le moteur contient un registre et des briques utiles, mais le document d'architecture décrit davantage de garanties que le câblage actuel. Il ne doit pas être présenté comme entièrement fonctionnel ou déployé.
