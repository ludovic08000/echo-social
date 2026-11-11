# Raccordement du moteur Zeus — 10 novembre 2026

## État du lot

Les neuf capacités sont raccordées dans la branche `codex/zeus-conversation-actions`, intégrée dans `codex/zeus-publication-20261110` avec les changements d’éditeur Lovable. Ce document remplace les constats de câblage incomplet de l’audit du 9 novembre. L’éditeur Cloud est maintenant accessible par navigateur. L’application des migrations, le déploiement et la publication doivent encore être prouvés séparément. Les essais sur appareils physiques restent à vérifier après activation.

## Parcours raccordés

| Capacité | Parcours | Confirmation minimale |
| --- | --- | --- |
| `activity.read` | Compteurs exacts liés au compte, lus et formatés localement | Non |
| `messages.send` | Résolution serveur du destinataire, puis transport Aegis existant | Oui |
| `calls.start` | Conversation normale, signalisation et média chiffré existants, reçu de démarrage | Oui |
| `posts.publish` | Réservation serveur, consommation unique dans `agent-actions`, identifiant du post | Oui |
| `friend_requests.list` | Demandes reçues en attente, jusqu’à 50 affichées et recherche par nom au-delà | Non |
| `friend_requests.show_profile` | Résolution parmi les demandes réelles, sélection des homonymes, route profil validée | Non |
| `friend_requests.respond` | Décision sur une demande reçue en attente et notification, dans une transaction | Oui |
| `feed.preferences.update` | RPC personnelle existante, historique et annulation existants | Oui |
| `appearance.feed.update` | Réglages locaux existants du feed, synchronisation des composants et annulation | Oui |

Le registre pur `supabase/functions/_shared/zeus-capabilities.ts` est partagé avec le client. Il n’importe ni SDK serveur ni secret. Le schéma frontend valide toutes les commandes. Les propositions ont une échéance locale de cinq minutes et utilisent l’horodatage renvoyé par le serveur pour la réservation, pour éviter une erreur liée à l’horloge de l’appareil. L’exécuteur n’interprète jamais implicitement un appel comme une confirmation.

Le chargement de l’historique ne remplace plus la proposition en cours lors de la création d’une conversation. Les réponses en attente sont invalidées quand le compte ou la conversation change. La lecture des compteurs vérifie aussi le compte attendu avant et après la réponse, pour ne pas ranger ou lire un résultat sous une autre session.

Les changements de feed concernent uniquement les préférences du compte. La configuration globale continue de passer par les propositions administrateur existantes. L’apparence conserve son stockage local par mode d’affichage : elle ne devient pas une préférence synchronisée entre appareils.

## Droits et administration

Le panneau existant d’administration Zeus contient l’éditeur des neuf capacités : activation, rôle requis, abonnement créateur payé et confirmation. Le serveur vérifie de nouveau ces règles à l’exécution ; l’accès vocal utilise aussi la fonction `voice_command_access` existante. Un changement exige le rôle administrateur vérifié dans la base, une révision attendue et un reçu de la nouvelle révision. Il écrit un journal avant/après. Une confirmation minimale ne peut pas être abaissée.

Les tables de politiques, audits et réservations résident dans `zeus_private`, sans accès direct aux tables pour les rôles clients. Ce schéma ne doit pas être exposé dans la configuration Data API. Les fonctions publiques délèguent à des fonctions internes avec identité et permissions explicites. Les lectures d’activité et de demandes conservent les règles RLS des données.

## Exécution unique et résultats incertains

Le serveur réserve une clé par compte. Il vérifie la capacité, la confirmation, l’échéance et les bornes : 60 nouvelles réservations par minute, 2 000 par jour et par compte. Une réservation n’est pas une preuve d’envoi ou de livraison.

Pour le feed personnel et les demandes d’amis, réservation, mutation et reçu sont dans la même transaction : une réponse perdue peut être relue sans répéter la mutation. L’acceptation conserve le vrai trigger de capacité des amitiés et crée une seule notification. Pour les publications du nouveau moteur, le serveur consomme une fois la réservation avant de publier. Les anciens clients restent compatibles avec le contrôle de capacité ; ils ne bénéficient pas de cette nouvelle réservation tant qu’ils ne sont pas mis à jour.

Les outils historiques de programmation de publication, story et génération d’image conservent leur parcours et partagent désormais le droit de publication. Leurs propositions annulées ou expirées ne sont plus exécutables. La nouvelle réservation durable de publication concerne le chemin `publish_post` du moteur.

Les appels et messages restent exécutés par leurs transports existants. Une réservation consommée sans reçu final reste un résultat inconnu : aucune relance automatique de l’effet. Le bilan, la conversation ou le feed permettent de vérifier son état. Les confirmations annulées, expirées ou appartenant à une ancienne proposition ne peuvent plus lancer une action.

Le registre ne conserve ni audio ni texte privé, ni empreinte du texte d’un message privé. Pour la messagerie, seule l’empreinte des métadonnées de commande et du destinataire est utilisée. Les réservations expirent après 30 jours, par lots de 10 000, via le job attendu `zeus-command-retention` à `35 3 * * *` UTC ; elles sont aussi supprimées avec le compte. Aucun enregistrement audio n’est ajouté. Le fournisseur de dictée du navigateur reste distinct du code applicatif, et les conversations textuelles de Zeus suivent leur historique existant.

## Vérifications locales

- Suite Zeus, appels, contrôles du feed et apparence : 221 tests réussis dans 29 fichiers, dont les 17 tests SQL des migrations et des protections serveur.
- Les 37 tests d’approbation et continuité d’appareil passent.
- TypeScript, le build de production, la frontière navigateur et le contrôle des artefacts publics passent.
- Les vérifications Libsignal WASM réelles passent dans les deux sens, avec rejouage, renouvellement, livraison différée et refus de substitution d’identité.
- Le lint ciblé des nouveaux modules ne signale pas d’erreur. Les alertes préexistantes des grands composants restent distinctes.
- Tests du code `agent-actions` : refus d’une capacité désactivée, refus d’une réservation absente/déjà consommée et publication après consommation confirmée.
- SQL PGlite : migrations successives, RLS, absence d’accès anonyme, droit administrateur, révisions et audit, abonnement valide/expiré, voix révoquée, clés par compte, échéance, rejouage sans doublon, capacité d’amis native et notification unique.
- Le runtime Deno n’est pas installé localement ; sa vérification et le déploiement Edge restent à faire dans Lovable Cloud. Aucun appel, publication ou message réel n’a été émis par les tests.

## Activation dans Lovable Cloud

Le rejeu CI a révélé une lacune historique : la migration Club `0026_fan_subscriptions_and_market_badge`, déjà appliquée dans Lovable Cloud le 9 octobre, manquait dans les sources de rejeu. Sa copie immuable est restaurée sous `20261009021231_fan_subscriptions_and_market_badge.sql`, à l’horodatage UTC du journal Cloud. Cette restauration sert aux bases de test neuves et ne doit pas être appliquée de nouveau sur Lovable Cloud. Le test de rejeu contrôle les tables, la confidentialité des abonnements et l’absence de droit client sur leur état de paiement.

1. Vérifier le projet `14bf9f2a-b211-4bff-8f3c-1cd3d8a0a907`, son schéma réel et sa sauvegarde. Vérifier que `zeus_private` n’est pas exposé dans la Data API.
2. Le préflight Cloud du 10 novembre confirme l’absence de `reduced_topics`, `feed_preference_change_history` et `apply_feed_preference_command`. Appliquer d’abord la migration manquante `20261027120000_feed_explicit_control.sql`, puis `20261109175107_zeus_activity_notification_retention.sql` et `20261109212104_zeus_capability_execution.sql`. Les deux nouvelles références utilisateur ciblent `public.profiles(user_id)` pour respecter Lovable Cloud et conserver la suppression en cascade avec le compte. La lecture de l’historique est accordée à `authenticated`, sous RLS. Ne rejouer aucune autre ancienne migration. Le journal Cloud `drizzle/migrations` reste distinct des sources `supabase/migrations` ; ne pas exécuter les deux historiques sur la même base.
3. Vérifier les conseillers de sécurité, les permissions et les RPC avec des comptes de test autorisés. Contrôler aussi les schémas/types et le runtime Edge. Aucun diagnostic simulé ne remplace ces étapes de production.
4. Pour les notifications, exécuter d’abord `purge_old_notifications(true)`, vérifier les nombres puis l’archivage autorisé. La rétention est de 30 jours pour les notifications lues, 90 pour les non lues, avec sept jours avant suppression physique. Aucune archive de message n’est concernée.
5. Vérifier les deux jobs dans `cron.job` et leurs exécutions dans `cron.job_run_details`. Si `pg_cron` est absent, un avertissement est émis : les purges ne sont pas actives.
6. Déployer `agent-chat` et `agent-actions` avec leurs imports `_shared`, puis publier le client validé. Vérifier le commit réellement servi et les parcours iOS/Android/Windows : micro, bilan, homonyme, annulation, message, appel et publication entre comptes de test consentants.

## Retour arrière

Pour arrêter une seule capacité, utiliser sa politique serveur. Pour un retour complet, restaurer le client et les deux fonctions Edge précédents avant d’envisager de retirer les objets SQL. Les nouveaux objets sont additifs ; les anciens circuits manuels restent présents. Conserver le journal des politiques et l’état des réservations pendant le diagnostic. L’annulation de l’archivage des notifications exige d’arrêter son job et de retirer la seule politique restrictive de rétention avant de remettre `archived_at` à NULL, pendant la grâce de sept jours. Les règles d’appartenance des notifications doivent être conservées.
