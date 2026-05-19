---
name: Lot 1+4 closure — Refanout & SK post-restore rotation
description: messageRouter requests refanout after 2 persistent decrypt failures (RPC request_message_refanout). senderKeyRotationWatcher rotates ALL owned chains on forsure:e2ee-post-restore.
type: feature
---

## Refanout queue (`src/e2ee-session/refanoutQueue.ts`)

- Per-messageId failure counter (RAM, GC at 1000 entries / 10 min TTL).
- After **2 consecutive failures** for a `(messageId, senderUserId)` pair, calls the RPC `request_message_refanout(p_message_id, p_sender_user_id, p_requester_device_id)`.
- 5-min throttle per messageId to prevent floods.
- On success, the router returns `REFANOUT_REQUESTED` and **does NOT mark the message as seen** → the next `messageQueue.resumeAll()` retries the freshly fanned-out copy.
- `clearDecryptFailure(messageId)` purges the counter on successful decrypt.

## Post-restore SK rotation (`src/lib/crypto/senderKeyRotationWatcher.ts`)

- `wirePostRestoreListenerOnce()` listens to the `forsure:e2ee-post-restore` window event (dispatched by `postRestoreSync`).
- `rotateAllOwnedChains(userId)` enumerates every `sender_key_state` row where `sender_user_id=userId AND sender_device_id=myDeviceId AND is_owner=true`, calls `rotateOwnerSession` on each, and clears `invalidateSenderKeysFlag(convId)`.
- Result: after a restore (recovery key / PIN / password), every group the user owns gets a brand-new chain on the next outbound send, with SKDM re-fanned to all peers.

## Why this closes Lot 1+4

- Lot 1.3 ("messageRouter on decrypt failure call request_message_refanout") → done.
- Lot 4.3 ("force SK rotation on ALL groups after restore") → done.
- Lot 4.4 ("auto-fast-forward via refanout post-restore") → indirectly covered: postRestoreSync triggers resumeAll → messageRouter retries → refanout if still failing.

## Not done (deliberately deferred)

- Lot 1.1 (`peerKeyCache.keys_epoch`) — moot: `fetchPrekeyBundleForDevice` does NOT cache, and realtime `device_signed_prekeys.UPDATE` already invalidates the ratchet session via `invalidateDeviceSession`.
- Lot 2 (SVR2 PIN hardening) and Lot 3 (Sesame device-linking SKDM auto + progress UI) — separate efforts.
