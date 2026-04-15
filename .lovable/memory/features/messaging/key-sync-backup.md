---
name: E2EE Key Sync & Backup
description: Recovery key model (32 bytes random, PBKDF2+AES-256-GCM) replaces password-based backup. Full restore or explicit failure.
type: feature
---
## Architecture (Element/Matrix model)
- Random 32-byte recovery key generated client-side, displayed once as `ABCD-EFGH-...` groups
- Recovery key derives AES-256-GCM key via PBKDF2 (600k iterations)
- Complete backup bundle: identity keys, sessions, ratchet states, prekeys, PIN-wrapped keys, fingerprints
- Server stores only opaque encrypted blob (`user_backups` table)
- **Full restore or explicit failure** — no partial state
- Auto-backup: recovery key kept in volatile JS ref (RAM only), never persisted
- If recovery key is lost and no device available → new identity, old messages unrecoverable

## Files
- `src/lib/crypto/recoveryKey.ts` — generate, normalize, validate, format
- `src/hooks/useSecureBackup.ts` — createBackup returns recovery key, updateBackup, restoreBackup
- `src/hooks/useAutoBackup.ts` — setRecoveryKey/clearRecoveryKey (volatile ref)
- `src/components/KeyBackupPanel.tsx` — UI: create shows key once, restore requires key input
- Device transfer: QR + separate PIN (useDeviceLink) unchanged
