---
name: E2EE Key Sync & Backup
description: Account-based auto-backup (password-derived AES key, PBKDF2) replaces manual recovery key. Auto-restore on login, auto-sync on key changes.
type: feature
---
## Architecture (Google Key Vault model — v3)
- On login, AES-256-GCM key is derived from `password + userId` via PBKDF2 (600k iterations)
- Derived key stored in volatile JS ref (RAM only, cleared on tab close)
- All E2EE keys auto-encrypted and synced to `user_backups` table
- On next login with no local keys → auto-restore from server backup
- **Zero manual action** — no recovery key to note
- If password changes, backup re-encrypted at next login

## Files
- `src/lib/crypto/accountKeyBackup.ts` — derive key, encrypt/decrypt, sync, restore
- `src/hooks/useAccountKeySync.ts` — polls IndexedDB, auto-syncs on changes
- `src/pages/Login.tsx` — calls `initAccountKeySync(password, userId)` after successful login
- `src/App.tsx` — `AccountKeySyncRunner` component runs the sync hook
- `src/components/KeyBackupPanel.tsx` — UI shows auto-backup status, manual sync button, device transfer

## Legacy (kept for compatibility)
- `src/hooks/useSecureBackup.ts` — recovery key model (v2), still used by KeyBackupPanel fallback
- `src/hooks/useAutoBackup.ts` — old auto-backup with recovery key in memory
- Device transfer: QR + separate PIN (useDeviceLink) unchanged
