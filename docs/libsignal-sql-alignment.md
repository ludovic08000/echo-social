# Alignement SQL libsignal — 7 septembre 2026

La base Lovable Cloud a été inspectée directement après réactivation. Les quatre RPC libsignal sont présentes et leurs paramètres correspondent au client. `is_supported_aegis_device_copy` et `aegis_send_message` rejettent encore le format émis par le client libsignal.

Le correctif remplace la validation par le format courant `aegis.libsignal.<2|3>.<base64 canonique non vide>`, correspondant aux deux types gérés par le moteur Rust. Le client applique la même validation. Les droits de la fonction d'envoi, les contrôles de participants, d'appareils et l'idempotence sont conservés. Les copies nulles sont explicitement rejetées.

Les 43 copies historiques ne sont ni supprimées ni réencodées. La nouvelle contrainte est créée NOT VALID : elle contrôle les nouvelles écritures sans déclarer les anciennes lignes conformes au nouveau format.

Validation : migration exécutée sur la base réelle dans une transaction avec assertions SQL et ROLLBACK. Quatre formats valides acceptés, onze formats invalides rejetés, insertion sous contrainte testée dans une table temporaire, accès anonyme à l'envoi interdit et accès authenticated conservé. Après rollback : ancien validateur toujours actif et 43 copies conservées. Tests applicatifs : 684 réussis, 3 ignorés.

## Déploiement coordonné requis

La migration n'est pas appliquée durablement : l'appliquer avant le client libsignal bloquerait l'ancien client Aegis encore déployé. Publier le client compatible et migrer la base dans une même fenêtre de maintenance. La PR #85 n'est pas fusionnée dans main sans ordre explicite (AGENTS.md). Les anciennes versions clientes ne peuvent plus envoyer après la bascule.

Les tests de contrat ne prouvent pas un échange chiffré réel entre iOS, Android et Windows. Cette validation sur les clients déployés reste nécessaire après la bascule.
