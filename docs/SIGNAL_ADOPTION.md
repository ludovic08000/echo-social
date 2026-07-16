# Adoption sélective de Signal Desktop dans Sesame

Sesame réutilise uniquement des éléments de Signal Desktop qui peuvent être adaptés proprement à une application React/PWA. Le but n’est pas de présenter Sesame comme Signal ni de recopier son architecture Electron entière.

## Éléments adaptés

- État d’envoi monotone par destinataire : `Pending → Sent → Delivered → Read → Viewed`.
- Agrégation des états pour les conversations de groupe, avec visibilité des envois partiels.
- Métadonnées de message séparées du contenu authentifié.
- Présentation des échecs de livraison sans remplacer la bulle du message.
- Backoff exponentiel compatible avec les valeurs de Signal Desktop.
- Gestion de `Retry-After` et ajout d’un jitter complet pour éviter les vagues de reconnexion.
- Classification stable des erreurs : changement d’identité, appareils incohérents, limitation, réseau, serveur, session expirée et contenu invalide.

## Éléments volontairement non copiés

- Les composants Electron, Redux et Backbone de Signal Desktop.
- Les classes dépendantes de `@signalapp/libsignal-client` sans intégration formelle de libsignal.
- Les protocoles serveur, endpoints, certificats, clés ou identifiants propres au service Signal.
- Les mécanismes de groupes, appels, sauvegardes et pièces jointes qui supposent l’infrastructure Signal.
- Les marques, logos, assets et textes laissant croire à une affiliation avec Signal.

Copier ces éléments sans leurs dépendances et invariants de sécurité créerait une fausse impression de compatibilité et pourrait affaiblir le chiffrement de Sesame.

## Règles de sécurité pour la suite

1. Une erreur de clé d’identité ne doit jamais déclencher un renvoi automatique.
2. Un reçu authentifié peut faire avancer un état, jamais le faire reculer.
3. Un `Retry-After` serveur est prioritaire et ne doit pas être raccourci par le jitter.
4. Un échec partiel de groupe doit rester visible même si certains destinataires ont reçu le message.
5. Les messages en clair ne doivent pas être persistés dans IndexedDB.
6. Toute future intégration de libsignal doit être traitée comme un projet distinct, avec stockage de clés, migration, tests de compatibilité et audit.

## Sources et licence

Les fichiers adaptés portent leur copyright et leur identifiant SPDX. La source amont est `signalapp/Signal-Desktop`, distribuée sous `AGPL-3.0-only`. Sesame est également publié sous `AGPL-3.0-only`.

Sesame est un projet indépendant, sans affiliation ni approbation de Signal Messenger, LLC.
