# Moteur de capacités Zeus

## Objectif

Zeus est une interface conversationnelle au-dessus des fonctions existantes de ForSure. Le modèle propose une intention structurée ; il ne reçoit jamais d'accès direct à Supabase, aux clés privilégiées, au DOM ou à l'administration.

## Parcours d'une demande

1. Le client envoie la demande et le contexte conversationnel minimal à `agent-chat`.
2. Le modèle répond en langage naturel et, si nécessaire, avec une seule commande structurée.
3. Le client valide la commande avec Zod et la rattache au registre `ZEUS_CAPABILITIES`.
4. Les paramètres humains (nom d'un ami, nom d'un demandeur) sont résolus parmi les résultats serveur visibles par le compte connecté. Un identifiant produit par le modèle n'est jamais accepté.
5. La politique administrateur confirme que la capacité est active pour le rôle et l'abonnement.
6. Une action sensible ou réversible est présentée à l'utilisateur et expire après cinq minutes.
7. L'exécuteur serveur vérifie de nouveau l'identité, la cible, l'état courant et l'idempotence.
8. Zeus annonce un succès uniquement après un reçu serveur vérifiable.

## Niveaux de risque

- `read` : bilan, compteurs et liste de demandes ; aucune mutation.
- `navigate` : ouvrir le profil explicitement demandé ; aucune mutation.
- `reversible` : préférences personnelles du feed ou de l'apparence ; confirmation et annulation.
- `sensitive` : message, appel, publication et réponse à une demande d'ami ; confirmation explicite obligatoire.

Toutes les capacités sont limitées au compte connecté. Une demande conversationnelle ne peut jamais modifier l'algorithme global, les paramètres administrateur, les données d'un autre membre ou le thème global du site.

## Domaines

| Domaine | Lecture | Navigation | Mutation |
| --- | --- | --- | --- |
| Activité | messages, notifications, réponses, demandes d'amis | notification ou publication concernée | marquer comme lu ultérieurement |
| Messagerie | conversations autorisées | ouvrir une conversation | envoyer via le transport Aegis existant |
| Appels | disponibilité autorisée | ouvrir l'écran d'appel | lancer via le protocole d'appel existant |
| Publications | propres brouillons/publications | ouvrir une publication | publier après confirmation |
| Amis | demandes reçues | afficher le profil du demandeur | accepter ou refuser après confirmation |
| Feed | préférences personnelles | ouvrir les réglages | appliquer une modification réversible |
| Apparence | apparence personnelle | ouvrir les réglages | choisir uniquement une valeur autorisée |

## Administration

L'administration doit pouvoir activer une capacité, la réserver à un rôle ou un abonnement et imposer une confirmation plus stricte. Elle ne peut pas rendre une capacité moins sûre que le minimum défini dans le code. Les changements sont versionnés et audités.

## API

L'API externe sera ajoutée seulement après la validation du moteur interne. Elle réutilisera les mêmes schémas, politiques et exécuteurs ; elle ne dupliquera pas la logique. Aucun endpoint ne donnera accès au `service_role` sans filtrage explicite par l'identité du demandeur.

## Déploiement sûr

La migration activité/demandes d'amis est additive. Le retour arrière consiste à désactiver les nouvelles capacités dans la politique administrateur, puis à restaurer l'ancienne fonction de résumé. Les colonnes de rétention ne sont supprimées qu'après vérification qu'aucun client publié ne les utilise.
