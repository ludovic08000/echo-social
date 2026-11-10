# Zeus : conversation, activité et rétention des notifications

## État

Changements locaux sur `codex/zeus-conversation-actions`, à partir de `207e08b27f29ff24fbdecaef85dd4529d8efe99a`. Aucune migration de ce lot n'a été appliquée à Lovable Cloud et aucune publication n'est confirmée. Le connecteur Lovable est indisponible et le navigateur local était désactivé dans les réglages Work lors de la vérification.

## Parcours implémentés et testés localement

- Une première interaction ouvre le micro. Après une phrase finalisée, Zeus répond oralement, attend l'événement de fin de lecture puis reprend l'écoute. Pause, fermeture, retrait du droit vocal ou passage en arrière-plan arrêtent la boucle. Les erreurs de dictée imposent une nouvelle interaction.
- Le bilan lit une RPC liée à `auth.uid()` : messages non lus du compteur canonique de la messagerie, notifications non lues, commentaires sur ses propres publications et demandes d'amis reçues en attente. Il n'existe plus de plafond implicite de 50 notifications. Une erreur serveur n'est jamais transformée en zéro. Ces nombres sont formatés localement et ne sont pas transmis au modèle génératif.
- Messages, publications et appels attendent une confirmation locale explicite. Les homonymes demandent une sélection, les propositions expirent après cinq minutes. Un message passe par le transport Aegis existant ; un appel passe par la fenêtre et le protocole d'appel existants. Une publication exige un identifiant renvoyé par le serveur avant toute annonce de réussite.
- Une clé de commande limite les doubles confirmations dans l'instance cliente. Ce mécanisme n'est PAS une garantie d'idempotence serveur entre plusieurs onglets ou après rechargement.
- Le code n'enregistre aucun fichier audio de commande. La reconnaissance vocale reste celle du navigateur ; cette propriété ne décrit pas la conservation éventuelle du fournisseur de reconnaissance.

## Notifications

Rétention retenue : notifications lues de plus de 30 jours, non lues de plus de 90 jours. Une politique restrictive masque les éléments expirés ; la tâche serveur archive au maximum 10 000 lignes par passage, puis supprime physiquement les archives datant de plus de sept jours. Aucun message privé ni archive chiffrée de conversation n'est concerné.

La fonction `purge_old_notifications()` est en simulation par défaut, interdite aux rôles anonymes et authentifiés. Le rôle serveur peut l'exécuter. La modification d'`archived_at` est interdite aux utilisateurs ordinaires. La tâche attendue est `notification-retention`, à `15 3 * * *` UTC. En l'absence de `pg_cron`, la migration émet un avertissement : la purge ne doit pas être déclarée active.

## Ordre d'activation dans Lovable Cloud

1. Vérifier le projet `14bf9f2a-b211-4bff-8f3c-1cd3d8a0a907`, les fonctions existantes, le type `public.friendship_status`, les politiques de notifications et la présence de `pg_cron`. Utiliser la sauvegarde habituelle de la base.
2. Appliquer uniquement `20261109175107_zeus_activity_notification_retention.sql` après relecture. Elle ajoute les RPC d'activité, de recherche de contacts et de réponse aux demandes d'amis, ainsi que la rétention. Ne pas rejouer les migrations historiques.
3. Exécuter `select public.purge_old_notifications(true);`, conserver les nombres du résultat. Avant toute première exécution réelle, contrôler que les échéances correspondent aux règles ci-dessus.
4. Exécuter une passe d'archivage autorisée et vérifier son reçu. Confirmer le job dans `cron.job` et contrôler ensuite ses résultats dans `cron.job_run_details`. Ne pas prétendre que le planificateur a tourné sur le seul constat de sa création.
5. Vérifier les RPC avec un compte de test légitime, puis déployer `agent-chat` et le client. Les fonctions Edge ne doivent importer de code commun que depuis `_shared`.
6. Vérifier le commit réellement servi et les parcours sur iOS, Android et Windows : bilan, pause/reprise, refus micro, homonyme, annulation, envoi, publication et réception de l'appel. Les essais d'actions utilisent des comptes de test consentants.

## Retour arrière

Restaurer d'abord le client précédent et `agent-chat` précédent si nécessaire ; les nouveaux objets serveur sont additifs. Pour rétablir l'affichage des anciennes notifications durant la grâce : arrêter le job `notification-retention`, retirer la seule politique restrictive `Notification active retention`, puis remettre `archived_at` à NULL avec le rôle serveur. Préserver les politiques d'appartenance existantes. Ce retour doit se faire avant la suppression physique ; les lignes déjà supprimées nécessitent la sauvegarde de la base.

## Preuves locales et limites

- 24 fichiers de tests Zeus/vocal/appels : 182 tests réussis.
- Approbation et continuité des appareils : 37 tests réussis.
- TypeScript et build de production réussis ; contrôles de frontière navigateur et d'artefacts publics réussis.
- Vérifications WASM Libsignal réelles réussies : échanges croisés, rejouage, renouvellement, livraison différée et rejet de substitution d'identité.
- Tests PostgreSQL exécutés avec PGlite, dont le vrai type enum des demandes d'amis, les accès par rôle, les compteurs, la simulation de purge et la grâce avant suppression.
- Synthèse et reconnaissance testées avec des événements simulés. Aucun appel ni message réel envoyé, aucun enregistrement vocal réel et aucune notification réelle purgée. Ces tests ne remplacent pas les essais de matériel iOS/Android ou le planificateur de production.
- Le registre de capacités ajouté au projet reste partiellement raccordé ; voir l'audit `docs/architecture/zeus-capability-engine-review.md`. Les tests unitaires du registre ne valident pas son application à chaque action.

## Documentation consultée

- [Événement de fin de synthèse vocale](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/end_event)
- [Types enum PostgreSQL](https://www.postgresql.org/docs/current/datatype-enum.html)
- [Planification pg_cron](https://github.com/citusdata/pg_cron)
- [Gestion de sessions et appareils Signal Sesame](https://signal.org/docs/specifications/sesame/)
