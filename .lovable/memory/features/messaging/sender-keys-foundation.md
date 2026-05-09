---
name: L2 Sender Keys group encryption (full wiring)
description: Sender Keys auto-enabled for groups 3+ members, auto-rotation on member changes, full inbound/outbound pipeline live
type: feature
---

## Status — LIVE in send/receive pipeline

Sender Keys (Signal-spec group E2EE) is fully wired and active for every group conversation with 3+ members.

## Auto-enable trigger

DB trigger `maybe_enable_sender_keys_for_group` on `conversation_participants` INSERT/DELETE:
- Sets `conversations.enable_sender_keys=true` when the group reaches 3+ members.
- Never auto-disables (a chain stays valid for remaining members after a leave).
- Backfilled on migration for existing 3+ groups.

## Encryption path

`useE2EE.encrypt()` calls `tryEncryptViaSenderKeys()` first. When the conversation is opted in, the message is encrypted via the group chain (`sk1.` wire) and the SKDM is fanned out pairwise (Double Ratchet) to every peer device. Falls back transparently to pairwise ratchet on any failure (zero downgrade — both paths are E2EE).

## Decryption path

`useE2EE.decrypt()` detects `sk1.` wires and routes to `loadRecipientStateForWire` → `decryptFromGroup`. SKDMs are pulled by `senderKeyInbound`:
- `catchUpSenderKeyDistribution(userId)` on app boot + window focus
- `subscribeSenderKeyDistribution(userId)` realtime INSERT subscription

Both wired in `App.tsx`.

## Rotation on member change

`subscribeSenderKeyRotation(userId)` (new file `src/lib/crypto/senderKeyRotationWatcher.ts`) subscribes to `conversation_participants` realtime. When membership changes for a conversation where the local device owns a sender-key chain:
1. `rotateOwnerSession()` regenerates the chain
2. `invalidateSenderKeysFlag()` clears snapshot tracker
3. Next send re-fans the new SKDM

`conversation_participants` was added to `supabase_realtime` publication with REPLICA IDENTITY FULL.

## Auto-rotation thresholds (existing)

`maybeAutoRotate`: regenerates the chain after 1000 messages or 7 days.

## Files

- `supabase/migrations/*` — auto-enable trigger + backfill + realtime
- `src/lib/crypto/senderKeySession.ts` — owner/recipient state, rotation primitives
- `src/lib/crypto/senderKeyOutbound.ts` — `tryEncryptViaSenderKeys` + SKDM fanout
- `src/lib/crypto/senderKeyInbound.ts` — `catchUpSenderKeyDistribution` + realtime SKDM consumer
- `src/lib/crypto/senderKeyRotationWatcher.ts` — NEW, member-change rotation
- `src/hooks/useE2EE.ts` — encrypt/decrypt routing
- `src/App.tsx` — boots inbound + rotation subscriptions
