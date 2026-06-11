---
name: E2EE Key Sync & Backup Architecture
description: Signal-style Master Key system with dual wrapping (password + recovery key), atomic restore, content-based sync detection
type: feature
---

## Master Key Architecture (v5) — Signal SVR-inspired

A random 32-byte **Master Key** is generated once per account. It encrypts all E2EE material.
The Master Key itself is wrapped (encrypted) by two parallel mechanisms stored in `user_backups`:

### Password Wrapping (`backup_type = 'account'`, version 5)
- PBKDF2(password + userId, random salt, 600k iterations) → wrapping key
- Wrapping key encrypts Master Key → stored as `wrapped_master_key` + `master_key_iv`
- Master Key encrypts E2EE state → stored as `encrypted_blob` + `iv`
- Auto-restores on login if local keys missing
- Auto-syncs on key changes (30s polling with SHA-256 content digest)

### Recovery Key Wrapping (`backup_type = 'recovery'`, version 5)
- PBKDF2(normalizedRecoveryKey, random salt, 600k iterations) → wrapping key
- Wraps the SAME Master Key as password wrapping
- User saves recovery key manually — fallback if password changes

### Key Benefits vs v4
- **Password change safe**: Just re-wrap the same Master Key, no re-encryption of state
- **Recovery key always works**: Both wrappers share the same Master Key
- **No collision**: backup_type column + unique index `(user_id, backup_type)`
- **Legacy migration**: v3/v4 backups auto-migrated to v5 on first restore

### Restore Priority
1. Password-wrapped (automatic on login)
2. Recovery-key-wrapped (manual fallback in settings)

### iOS/WebView Cache Purge Recovery
- The encrypted Master Key backup also includes a bounded recent plaintext/media-key cache (`plaintext:cache`) exported from the local encrypted plaintext store.
- This mirrors Signal Secure Backups / WhatsApp encrypted backup behavior for recent readable history: after IndexedDB/WebView cache loss, restored keys plus the encrypted recent cache let the latest messages/media show immediately.
- `requestImmediateBackup()` must be called after successful send and successful decrypt so ratchet state + recent cache are captured before iOS can purge storage.
- On `forsure-keys-restored`, E2EE hooks must clear stale ratchet terminal failures and refs, re-init keys, then dispatch `forsure-decrypt-retry`.

### Strict Fingerprint Mode
Fingerprint change BLOCKS sending (`ready=false`, `initError='fingerprint_changed'`), requires explicit user acknowledgement via `acknowledgeFingerprint()`

## Files
- `src/lib/crypto/accountKeyBackup.ts` — Master Key generation, wrapping, encrypt/decrypt, sync, restore
- `src/hooks/useAccountKeySync.ts` — polls IndexedDB, auto-syncs on content changes
- `src/hooks/useSecureBackup.ts` — recovery key UI hook, delegates to Master Key system
- `src/hooks/useAutoBackup.ts` — legacy compat wrapper
- `src/pages/Login.tsx` — calls `initAccountKeySync(password, userId)` after login
- `src/App.tsx` — `AccountKeySyncRunner` runs sync hook globally
- `src/components/KeyBackupPanel.tsx` — UI for auto-backup status + device transfer
