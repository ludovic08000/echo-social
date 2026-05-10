# Architecture IndexedDB E2EE robuste — type Signal/WhatsApp Web

## Objectif

Formaliser un accès IndexedDB unifié, Safari/iOS-safe, avec une **machine d'état crypto centrale** qui empêche définitivement la boucle de recréation d'identité et les `database connection is closing` bloquants.

## État actuel (audit rapide)

- `src/lib/crypto/indexedDb.ts` existe déjà → singleton DB + override de `db.close()` + `safeIDB`. **Bonne base, à étendre.**
- `src/lib/crypto/sessionInvalidation.ts` ouvre `forsure-ratchet` via une **2e connexion brute** (pas de singleton, pas de retry).
- `src/hooks/useAccountKeySync.ts` orchestre la restauration en 4-5 effets React → c'est lui qui décide de relancer la crypto. **C'est là que la boucle peut naître.**
- Pas de couche "memory cache" formelle ni de state machine — chaque hook décide pour lui-même.
- `keyManager`, `accountKeyBackup`, `pinWrap`, `keySentinel` cohabitent sans contrat unifié.

## Plan d'implémentation

### 1. Couche d'accès unique IndexedDB (`src/lib/crypto/indexedDb.ts`)

Étendre le singleton existant avec :
- **Write queue** sérialisée par store (FIFO) → empêche les transactions concurrentes.
- **Retry exponentiel** (50/150/400 ms) sur `InvalidStateError`, `TransactionInactiveError`, `database connection is closing` → `reopenE2EEDB()` puis rejoue.
- **Pattern transaction strict** : helper `runTx(stores, mode, fn)` qui ouvre, exécute *synchrone*, attend `complete`. Aucun `await` externe autorisé dans `fn`.
- Handlers `onclose` / `onversionchange` / `onerror` qui invalident le singleton **sans** déclencher de side-effect crypto.
- Suppression interdite : `deleteDatabase` ne doit plus être appelé au boot (ajout d'une garde).

### 2. Cache mémoire (`src/lib/crypto/memoryIdentityCache.ts`) — nouveau

- WeakMap-style en module (RAM uniquement, jamais persisté).
- API : `get(userId)`, `set(userId, identity)`, `clear(userId)`, `clearAll()`.
- Stocke : référence `CryptoKey` non-extractable, deviceId, derniers ratchet headers chauds.
- Vidé sur : logout, lock PIN, idle, `visibilitychange`→hidden long, `forsure-e2ee-security-epoch-changed`.

### 3. Machine d'état (`src/lib/crypto/CryptoStateMachine.ts`) — nouveau

États : `uninitialized → storage_checking → (identity_loaded | backup_restore_required → backup_restoring → identity_loaded | identity_creating → identity_loaded) → ready` + terminaux `storage_unavailable`, `compromised`.

Transitions :
- Une seule instance globale par `userId`.
- **Verrou** : `identity_creating` n'est atteignable **qu'une fois par session** et seulement après vérification explicite "pas de backup serveur + pas de sentinelle".
- Émet des events DOM (`forsure:crypto-state`) — les hooks React **écoutent**, ne décident plus.
- `transition(to, reason)` log structuré + refus si transition illégale.

### 4. KeyManager unifié (`src/lib/crypto/keyManager.ts`)

API publique exposée à l'app :
- `getIdentity(userId)` : memory → IndexedDB → null (jamais de création implicite).
- `ensureIdentity(userId)` : passe par la state machine, déclenche le flow boot.
- `purgeLocal(userId, reason)` : RAM + IndexedDB des clés sensibles uniquement.
- `setIdentity(...)` : écriture **uniquement** depuis state machine (`identity_creating` ou `backup_restoring`).
- Rétrocompatible avec les imports existants (`hasRawIdentityKeys`, etc.).

### 5. RecoveryManager (`src/lib/crypto/recoveryManager.ts`) — nouveau

- Centralise les 3 voies : PIN backup (L5), recovery key 64-hex, passkey/WebAuthn.
- Appelé uniquement depuis l'état `backup_restoring`.
- Renvoie un résultat typé `{ ok: true, source } | { ok: false, reason }` — la state machine décide ensuite.
- Wrapper autour de `accountKeyBackup`, `pinWrap`, `passkeyVault`, `recoveryKey` existants (pas de réécriture de la crypto).

### 6. Flow boot unifié

Remplace la cascade actuelle de `useAccountKeySync` par un orchestrateur idempotent :

```text
boot
 └─ memoryCache.get
     ├─ hit  → state=ready
     └─ miss → IndexedDB
                ├─ hit  → state=identity_loaded → ready
                └─ miss → check server backup (sentinel + user_backups)
                           ├─ exists → state=backup_restore_required
                           │            → UI dialog (PIN/recovery/passkey)
                           │            → restore → identity_loaded
                           └─ none   → state=identity_creating (1 fois max)
                                       → bump identity_epoch
                                       → fire security_code_changed
```

### 7. Sessions ratchet & sender keys

- `sessionInvalidation.ts` : remplacer son ouverture brute de `forsure-ratchet` par le helper `runTx` du singleton, mêmes garanties Safari.
- Sender key state : confirmer que le hot path passe bien par `runTx`.
- Skipped keys : confirmer wrap SWK + ajouter TTL config (`24h` défaut, max `7j`).

### 8. Purge hardening

- Hook unique `purgeOnLockEvents` qui écoute `visibilitychange`, idle (> 5 min), explicit lock, logout, `security_epoch_changed` → vide RAM, conserve IndexedDB chiffrée.
- Après config PIN : aucune clé JWK brute ne reste — déjà géré par `pinWrap`, on ajoute une assertion en debug.

### 9. Migration des call sites

Les hooks/composants existants (`useAccountKeySync`, `useE2EE`, `useMessageQueue`, `senderKeyRotationWatcher`, `keySentinel`, etc.) :
- ne décident plus de créer une identité ;
- appellent `keyManager.ensureIdentity()` et écoutent `forsure:crypto-state` ;
- conservent leurs responsabilités métier (sync backup, queue, watcher membres).

### 10. Tests (`src/lib/crypto/__tests__/`)

Nouveaux tests Vitest (`fake-indexeddb` déjà setup) :
- `cryptoStateMachine.test.ts` — interdit `identity_creating` deux fois.
- `indexedDbResilience.test.ts` — purge Safari simulée, `InvalidStateError`, `TransactionInactiveError`, `db.onclose`.
- `recoveryManager.test.ts` — PIN / recovery / passkey paths.
- `memoryIdentityCache.test.ts` — clear sur lock/blur/idle.
- `bootFlow.test.ts` — IndexedDB vide + backup serveur → restore_required (jamais création).
- Étendre les tests existants `multiDeviceIntegration` pour vérifier la non-régression sender keys.

## Fichiers

**Créés** : `memoryIdentityCache.ts`, `CryptoStateMachine.ts`, `recoveryManager.ts` + 5 fichiers de tests.

**Étendus** : `indexedDb.ts` (write queue + retry + runTx), `keyManager.ts` (API unifiée), `sessionInvalidation.ts` (passe par singleton), `useAccountKeySync.ts` (devient pur listener).

**Inchangés** : crypto primitives (`ratchet`, `x3dh`, `senderKeys`, `kdfChain`, `pinWrap`, `accountKeyBackup`), wire formats, schémas DB.

## Garanties post-implémentation

- IndexedDB vide ne déclenche **jamais** une recréation directe — passe toujours par la state machine.
- Plus de `Maximum update depth` : les hooks React n'ont plus de boucle de décision crypto.
- `database connection is closing` géré silencieusement par retry/reopen.
- Safari/iOS : RAM cache permet de tenir le temps qu'IndexedDB se ré-ouvre après ITP/background.
- Architecture lisible et auditable, alignée Signal/WhatsApp Web.

## Mémoire

À enregistrer après implémentation : nouvelle entrée `mem://tech/messaging/indexeddb-architecture` documentant la state machine + l'interdiction de créer une identité hors d'elle.
