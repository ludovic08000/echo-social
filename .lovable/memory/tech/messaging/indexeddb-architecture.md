---
name: IndexedDB Architecture
description: Singleton DB + write queue + retry helper, RAM cache, CryptoStateMachine prevents identity recreation loops, RecoveryManager routes PIN/recovery/passkey
type: feature
---

# E2EE IndexedDB Architecture (Signal/WhatsApp Web style)

## Modules

- `src/lib/crypto/indexedDb.ts` — singleton connection, `db.close()` overridden, `onversionchange`/`onclose` invalidate the singleton without side-effects.
- `src/lib/crypto/indexedDbTx.ts` — **only** sanctioned way to write: `runTx(stores, mode, fn)`, `txGet/Put/Delete/Clear`. FIFO queue per store-set + exponential retry (50/150/400 ms) on `InvalidStateError` / `TransactionInactiveError` / "database connection is closing".
- `src/lib/crypto/memoryIdentityCache.ts` — RAM-only hot cache (CryptoKey, deviceId). Cleared on epoch change, lock, logout, hidden > 5 min.
- `src/lib/crypto/CryptoStateMachine.ts` — single source of truth. **Hard lock**: `identity_creating` is reachable **at most once per session**. `withEnsureLock()` shares the boot promise across concurrent callers.
- `src/lib/crypto/recoveryManager.ts` — `attemptRecovery({source: 'pin'|'recovery_key'|'passkey'})` returns tagged `{ok, source, reason}` — never throws.
- `src/lib/crypto/sessionInvalidation.ts` — uses the same Safari-safe pattern (retry + always close after tx) for the `forsure-ratchet` DB.

## Boot flow

```
boot
 └─ memoryCache → IndexedDB → server backup probe
                                ├─ exists → backup_restore_required → UI dialog → backup_restoring → identity_loaded
                                └─ none   → identity_creating (1× max) → identity_loaded
```

## Hard rules

- IndexedDB is **jetable** (Safari ITP, mode privé, clear cache). Code must survive purge.
- Hooks **never** decide to create an identity — they listen to `forsure:crypto-state` and call `keyManager.ensureIdentity()`.
- No `deleteDatabase` at boot.
- Allowed in IndexedDB: identity priv keys (CryptoKey non-extractable when possible), Double Ratchet state, skipped keys (wrapped via SWK), sender keys, deviceId.
- Forbidden: media blobs, plaintext, server tokens.
- Skipped key TTL = 24 h default (override `localStorage.e2eeStrictSkippedTtl=false` → 7 d).

## Tests

`src/lib/crypto/__tests__/cryptoStateMachine.test.ts`, `memoryIdentityCache.test.ts`, `indexedDbResilience.test.ts`, `recoveryManager.test.ts`. The state-machine test explicitly proves no double identity creation.
