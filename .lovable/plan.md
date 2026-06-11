# Stabilisation E2EE — « Aucun message perdu »

## Problème

Aujourd'hui chaque message est chiffré par Double Ratchet (forward secrecy). Si le device qui détenait la session DR disparaît (nouveau navigateur, cache iOS purgé, ghost device quarantiné), **les anciens messages deviennent définitivement illisibles** — c'est ce qui s'est passé pour 7 messages de la conv `b20b5f51…`.

Le fanout multi-device (A1) ne résout que les **futurs** messages. Il faut une couche d'archive pour le passé.

## Solution : Archive Key par conversation

On ajoute une **clé symétrique long-life** par conversation (`ConvArchiveKey`, AES-256-GCM), chiffrée par la clé maître du compte (déjà existante via Backup PIN L5 / Key Sync Backup). À chaque envoi, on duplique le ciphertext :

- **Payload DR** (inchangé) → forward secrecy pour le temps réel
- **Payload Archive** → chiffré avec `ConvArchiveKey`, lisible par tout device qui peut dériver la clé maître

Un nouveau device qui s'authentifie récupère la clé maître (via password/PIN/recovery code → backup déjà en place), déchiffre toutes les `ConvArchiveKey` de l'utilisateur, et peut relire 100 % de l'historique.

C'est exactement le modèle WhatsApp **« sauvegarde chiffrée de bout en bout »** activée.

## Architecture

```text
account_master_key  (déjà dérivé par PBKDF2 du password, jamais en DB clair)
        │
        ▼ wrap (AES-GCM)
conversation_archive_keys   ← nouvelle table (RLS user)
  conversation_id | wrapped_key | created_at
        │
        ▼ unwrap en RAM
ConvArchiveKey  (AES-GCM 256)
        │
        ▼ encrypt
messages.archive_body  ← nouvelle colonne nullable
```

À l'envoi : `body` (DR fanout) **+** `archive_body` (single archive payload).
À la lecture : essayer DR → fallback archive → fallback placeholder.

## Lots de livraison

### Lot 1 — Backend (migration)
- Table `conversation_archive_keys (conversation_id, user_id, wrapped_key, kdf_version, created_at)` + RLS owner + GRANTs.
- Colonne `messages.archive_body text NULL`.
- RPC `get_or_create_archive_key(conv_id)` (security definer, retourne le wrapped_key existant ou exige du client qu'il en publie un nouveau).
- Trigger : `archive_body` immuable après insert.

### Lot 2 — Crypto client (`src/lib/messaging/archive/`)
- `archiveKeyManager.ts` : génère/dérive/wrap `ConvArchiveKey` à la 1ère utilisation d'une conv, persiste dans IndexedDB **et** sur Supabase (wrappé).
- `encryptArchive(plaintext, convId)` / `decryptArchive(payload, convId)`.
- Hook dans `messageSender.ts` : duplique le plaintext en `archive_body` avant insert.

### Lot 3 — Lecture
- Dans `decryptIncomingMessage` : si DR échoue (2 essais + refanout déjà tenté), tenter `decryptArchive`. Logger en INFO, pas en ERROR.
- Suppression du log « unsupported encrypted messages left visible ».

### Lot 4 — Restauration nouveau device
- À l'unlock du compte (via password ou Backup PIN), déclencher `restoreArchiveKeys()` : récupère toutes les `wrapped_key`, les unwrap en RAM, déchiffre l'historique.
- Bandeau « Historique restauré ✓ » discret.

### Lot 5 — Migration des messages existants
- Impossible pour les 7 messages déjà perdus (plaintexts inexistants).
- Pour les conversations actives, à la prochaine ouverture le sender produit la `ConvArchiveKey` et tous les **nouveaux** messages seront archivés. Un message bot système une fois indique « ✓ Historique chiffré activé ».

### Lot 6 — UX
- Toggle dans `Paramètres → Sécurité` : « Sauvegarde chiffrée d'historique » (activé par défaut).
- Si désactivé → comportement actuel (forward secrecy stricte).
- Note explicative : « Permet de relire vos messages sur un nouvel appareil. Toujours chiffré de bout en bout, le serveur ne peut pas les lire. »

## Garanties préservées

- **Zero-access** : le serveur ne voit que `wrapped_key` (chiffré par la clé maître dérivée du password, jamais transmise).
- **PIN purge** : l'archive key est elle aussi purgée d'IndexedDB sur blur/idle/PIN, comme les autres clés.
- **Quarantaine** : ghost devices toujours filtrés (A1 + quarantine_ghost_e2ee_devices déjà en place).
- **Audit** : chaque création/restauration loggée dans `user_recovery_events`.

## Trade-off assumé

Cette couche **assouplit la forward secrecy** : si la clé maître est compromise, l'attaquant peut déchiffrer tout l'historique archivé. C'est le compromis que font WhatsApp/Telegram/iMessage avec leurs backups. L'utilisateur peut le refuser via le toggle.

## Détails techniques

- AES-256-GCM avec IV 12 octets aléatoires par message d'archive.
- `wrapped_key` = AES-GCM(account_master_key, ConvArchiveKey) + IV.
- Rotation : `ConvArchiveKey` rotée à chaque changement de PIN (re-wrap en lot).
- Format de `archive_body` : `{v:1, iv, ct}` JSON base64 (~ +30 % de taille par message).

## Ordre d'exécution

1. Migration SQL (Lot 1) — bloquante, requiert approbation.
2. Code crypto + sender + decryptor (Lots 2-3) — en parallèle après migration.
3. Restauration + UX (Lots 4-6) — après tests Lots 2-3.
