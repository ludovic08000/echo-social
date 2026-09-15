# Diagnostic Aegis : clés, sessions et jetons

Ces traces observent les contrôles existants. Elles ne réparent pas les clés, ne changent pas les permissions et ne forcent jamais un appareil à devenir prêt.

## Dans la messagerie

Ouvrir « Diagnostic de finalisation », activer « Debug 10 minutes », reproduire le problème puis copier le diagnostic. L'écran affiche 20 étapes, mais l'export contient les tampons complets disponibles (600 événements de finalisation et 300 de messagerie maximum). Les anciennes entrées sont écrasées : exporter rapidement après le problème. L'export reste local, il n'est pas envoyé automatiquement au serveur.

Équivalent console : `forsureDebug.enable()`, `await forsureDebug.report()`, `forsureDebug.disable()`. Le debug console est désactivé par défaut et expire après dix minutes dans cet onglet, même après rechargement. Les tampons assainis restent disponibles sans activer la console.

- `device_keys.signingMatches` / `exchangeMatches` : comparaison de la clé publique locale à la clé enregistrée pour le couple compte/appareil. `skipped` signifie que la clé locale manque, pas qu'elle est valide.
- `device_binding.authorization_keys_match` : les clés utilisées pour préparer l'autorisation correspondent aux clés locales attendues.
- `device_binding.server_result` : résultat du rattachement serveur, avec vérification du DeviceID retourné. `already_bound` n'est pas une nouvelle vérification de signature.
- `crypto_readiness.device_state` : état exact au refus. `routingStatus=ready` et `lifecycleStatus=syncing` ne signifient pas que le moteur est prêt. Le code `CRYPTO_NOT_READY` n'est plus caché par `UNKNOWN_ERROR`.
- `LOCAL_DEVICE_NUMBER`, `REMOTE_DEVICE_NUMBER`, `CLAIM_REMOTE_PREKEY_BUNDLE`, `LIBSIGNAL_ESTABLISH_SESSION`, `SESSION_FRESHNESS_COMMIT`, `LIBSIGNAL_ENCRYPT`, `LIBSIGNAL_DECRYPT` localisent les échecs du moteur. Libsignal reste responsable de ses vérifications cryptographiques ; une préclé reçue n'est pas déclarée vérifiée par ces logs.
- `AUTH_TOKEN_PRESENT` et `AUTH_TOKEN_LOCAL_EXPIRY` sont des observations locales, pas une validation de la signature JWT.

## Sur le serveur

Les journaux JSON portent `event=aegis_checks`, `service`, `diagnostic_id`, `failed_check`, `error_code` et une carte `checks` (`pass`, `fail`, `not_checked`). Le serveur génère un identifiant aléatoire par requête, retourné dans `x-aegis-diagnostic-id`. Le transport navigateur le capture pour retrouver le journal de la passerelle. Aucun compte, clé ou jeton n'est encodé dans cet identifiant.

La passerelle distingue la présence syntaxique du Bearer, le JSON, l'appel RPC et la réponse. Elle transmet le JWT à Supabase : elle ne prétend pas vérifier elle-même sa signature. Un SQLSTATE est conservé dans `request_complete`; un code métier connu, comme `E2EE_SENDER_DEVICE_NOT_TRUSTED`, est conservé dans `aegis_checks`. Les messages libres ne sont pas logués.

`sealed-mint-token` trace la validation Auth, l'accès à la conversation, les deux appartenances, la signature et la persistance du jeton. `sealed-relay` trace la structure du jeton, son rattachement à la conversation et au destinataire, sa durée de vie, son MAC puis sa consommation atomique avec le relais. Aucun second appel de diagnostic ne consomme un jeton. `TOKEN_CONTEXT_MISMATCH`, `TOKEN_NOT_FOUND` et `TOKEN_CONSUMED` sont distingués dans le journal serveur.

Ces fonctions sealed-sender ne sont pas nécessairement utilisées par l'envoi Libsignal courant : ne pas attendre leurs logs pour un trajet qui ne les appelle pas. Avec `VITE_AEGIS_SERVER_URL` absent, le transport appelle directement Supabase ; les étapes du navigateur indiquent `transport=supabase`, sans prétendre qu'une requête est passée par la passerelle.

## Debug opérateur temporaire

Configurer **côté serveur**, jamais via un header fourni par le navigateur :

```text
AEGIS_LOG_LEVEL=debug
AEGIS_DEBUG_UNTIL=<date UTC ISO dans les 15 prochaines minutes>
```

Le debug ajoute les durées par contrôle aux logs normaux. La date est obligatoire ; une échéance expirée, invalide ou trop éloignée n'active pas le debug. Un redémarrage ne repousse pas cette date. Désactiver avec `AEGIS_LOG_LEVEL=info` et supprimer l'échéance. L'activation navigateur n'active pas le serveur.

Pour Docker Compose, les variables sont transmises par `infra/aegis-server/compose.yaml` (contexte de build : racine du dépôt). Pour Vercel, les définir dans l'environnement du projet de la passerelle et redéployer. Pour les Edge Functions, les définir comme secrets Supabase. Ne pas utiliser l'éditeur/agent Lovable pour activer ce mode sans vérifier les effets sur la branche et le déploiement.

Lire les journaux stdout du conteneur, les runtime logs de la passerelle Vercel ou les logs Supabase de la fonction correspondante. Filtrer par `diagnostic_id`. Les contrôles sont regroupés en un seul événement par requête, pas une ligne par clé ou par étape. La passerelle conserve aussi son résumé HTTP existant. Appliquer la rétention et les droits opérateurs de l'hébergeur ; aucune nouvelle base de logs ni console administrateur publique n'est créée ici.

## Confidentialité et limites

Ne jamais partager les coffres, clés privées, PIN, JWT, jetons de relais, MAC, nonce ou corps de message. Le rapport contient des références pseudonymisées et des statuts : le traiter comme un diagnostic privé. Les codes inconnus restent génériques, sans texte serveur brut.

Ces tests ne prouvent pas une livraison sur des appareils physiques. Le refus `CRYPTO_NOT_READY:key_setup_required` observé quand la route est prête mais le cycle reste en synchronisation est maintenant identifiable ; ce lot de journalisation ne modifie pas cet ordre de finalisation.
