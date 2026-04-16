---
name: E2EE Key Sync & Backup Architecture
description: Dual backup system (account-based + recovery key) with atomic restore, strict fingerprint mode, content-based sync detection
type: feature
---

## Backup Architecture (v4)

Two backup types coexist in `user_backups` table via `backup_type` column:

### Account-based (`backup_type = 'account'`, version 4)
- `src/lib/crypto/accountKeyBackup.ts`
- Key derived from `password + userId` via PBKDF2 (600k iterations)
- **Random salt** stored alongside each backup (not deterministic from userId)
- Password kept in volatile memory (`_sessionPassword`) for re-derivation
- Auto-restores on login if local keys are missing
- `useAccountKeySync` polls every 30s with **content-based SHA-256 digest** (not just count)
- `computeLocalCryptoDigest()` hashes all stores: E2EE, ratchet, pin-wrap, prekeys

### Recovery Key (`backup_type = 'recovery'`, version 2)
- `src/hooks/useSecureBackup.ts`
- Random 32-byte recovery key, PBKDF2-derived AES-256-GCM
- User must save recovery key manually
- Used as fallback / advanced option

### Key Design Decisions
- **No collision**: Each type has its own row via unique index `(user_id, backup_type)`
- **Version guard**: Account restore refuses v2 (recovery) format and vice versa
- **Truly atomic restore**: All stores saved before overwrite; full rollback on ANY failure
- **`hasLocalKeys()`** checks raw identity-keys + pin-wrapped keys + ratchet states
- **Strict fingerprint mode**: Fingerprint change BLOCKS sending (`ready=false`, `initError='fingerprint_changed'`), requires explicit user acknowledgement via `acknowledgeFingerprint()`

## Files
- `src/lib/crypto/accountKeyBackup.ts` — derive key, encrypt/decrypt, sync, restore
- `src/hooks/useAccountKeySync.ts` — polls IndexedDB, auto-syncs on changes
- `src/hooks/useSecureBackup.ts` — recovery key model (v2)
- `src/pages/Login.tsx` — calls `initAccountKeySync(password, userId)` after successful login
- `src/App.tsx` — `AccountKeySyncRunner` component runs the sync hook
- `src/components/KeyBackupPanel.tsx` — UI shows auto-backup status, manual sync button

## Legacy (kept for compatibility)
- `src/hooks/useAutoBackup.ts` — old auto-backup with recovery key in memory
- Device transfer: QR + separate PIN (useDeviceLink) unchanged
