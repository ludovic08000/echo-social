---
name: TOFU Recovery-Aware
description: After restore, peer fingerprint rotation banner shows "this contact restored their account" (recovery_restore) instead of generic MITM warning. Global SafetyNumberRevalidationBanner prompts user to re-verify Safety Numbers.
type: feature
---

# Lot 4 — TOFU recovery-aware + Safety Numbers revalidation

## Wire

1. `runPostRestoreSync()` publishes a recovery marker into
   `user_recovery_events` (user_id, fingerprint, reason, occurred_at) AND
   dispatches `forsure:e2ee-post-restore`.
2. Peers running `checkFingerprintChangeWithServer` look up
   `peerHasRecentRecoveryMarker(peerUserId, newFp)` (24h window). If matched,
   the new `user_identity_change_events` row is tagged
   `change_type = 'recovery_restore'`.
3. `IdentityChangeBanner` reads `changeType` and switches to a reassuring
   sky-colored copy when it equals `recovery_restore` (vs amber MITM copy).
4. `SafetyNumberRevalidationBanner` mounted globally in `App.tsx` listens to
   `forsure:e2ee-post-restore` and shows a floating top banner inviting the
   user to re-verify Safety Numbers with their contacts (auto-dismiss 20s).

## DB

- `user_identity_change_events.change_type` text NOT NULL DEFAULT
  `'identity_rotation'` CHECK IN (`identity_rotation`, `recovery_restore`).
- `user_recovery_events` (user_id, fingerprint, reason, occurred_at) with
  RLS: insert-self, select-authenticated. Trigger purges entries older than
  7 days on every insert.

## Files

- supabase/migrations/2026… (lot 4 schema)
- src/lib/crypto/recoveryMarkers.ts (publish + peer lookup)
- src/lib/crypto/identityChangeLedger.ts (+changeType, upgrade-in-place)
- src/lib/crypto/fingerprintTracker.ts (recovery_restore classification)
- src/lib/crypto/postRestoreSync.ts (publish marker before event dispatch)
- src/components/messages/IdentityChangeBanner.tsx (dual sky/amber copy)
- src/components/messages/SafetyNumberRevalidationBanner.tsx (global)
- src/App.tsx (mount)
