# Aegis clean rebuild

This branch rebuilds the messaging and call security architecture directly from `main`.

There is no production compatibility requirement. Test messages, obsolete schemas, unused RPCs and abandoned migrations may be removed.

## Non-negotiable rules

- One active send path.
- One active device model.
- One active wire format.
- One active database schema and one final migration set.
- No legacy fallback or dual reader.
- No rollback of cryptographic state after an ambiguous server result.
- No raw LiveKit call key stored in the database.
- No message plaintext in server logs, push payloads or moderation services.
- Every stage must pass typecheck, targeted tests, full tests and build before the next stage.

## Ordered stages

1. ✅ Baseline architecture and executable protocol tests.
2. ✅ Idempotent message transaction and authoritative send receipt.
3. ✅ Device identity, X3DH, Double Ratchet and complete fan-out.
4. ✅ Cross-tab locking and durable encrypted outbox.
5. ✅ Call-scoped LiveKit rooms, invitations and per-device call-key delivery.
6. ✅ Recovery vault and non-destructive key restore.
7. ✅ View-once consumption, deletion and local-cache cleanup.
8. ✅ Privacy boundaries for logs, push notifications and server functions.
9. One clean SQL reset for development data and obsolete Aegis objects.
10. Full CI and manual two-account, multi-device and group-call verification.

## Stage 2 invariant

One stable message UUID identifies one immutable encrypted request. Calls for that UUID are serialized in PostgreSQL. A timeout or malformed success response keeps the Ratchet and encrypted outbox pending; only an exact authoritative commit receipt clears them. An explicit rejection may rewind state only after the serialized server call has finished.

## Stage 3 invariant

Every routable installation is authorized by the account identity before it can publish prekeys or receive a device copy. X3DH verifies the account binding, the device authorization and the signed prekey before establishing a session. Each sender-device/recipient-device pair owns an independent Double Ratchet session, including bounded skipped keys, replay rejection and delivery out of order. Fan-out is complete or the message transaction is rejected.

## Stage 4 invariant

The complete immutable encrypted request is durable before network delivery and remains stored until an exact authoritative receipt or an explicit user deletion. Pending and unreadable rows are never silently pruned. Every outbox row, conversation send and device-session mutation is single-flight across tabs through Web Locks or a renewable IndexedDB lease, and concurrent first-run key creation converges on one non-extractable local AES key.

## Stage 5 invariant

Each call owns one immutable UUID and one LiveKit room named from that UUID, never from a conversation identifier. The call key is encrypted independently for every routable account-authorized device with an ephemeral X25519 exchange and AES-GCM metadata binding. The server stores only per-device envelopes and issues a call token only to the authorized device named by the caller record or an active invitation. Missing, revoked or unmatched devices fail closed.

## Stage 6 invariant

The recovery vault contains only the portable X25519 and Ed25519 account identity. It never contains or replaces a device identifier, device private key, prekey, Double Ratchet state, outbox row or decrypted-message cache. The vault is encrypted locally with a random 256-bit recovery key through HKDF-SHA-256 and AES-GCM metadata binding. A restore installs the identity only when no local identity exists and the vault fingerprint is compatible with the active server identity; every mismatch fails closed without modifying local state. Vault generations increase exactly by one under a serialized server transaction. Rotation is explicit, the new key is displayed once, and no background process can silently revoke the user's saved key.

## Stage 7 invariant

A view-once media message is removed from the normal message and device-copy read paths before it becomes visible. The server stores one sealed payload per recipient account and grants a short claim only to an authorized device. The encrypted media is downloaded before the addressed Double Ratchet capsule is opened, and the recipient payload is destroyed only after an exact idempotent consumption receipt. The sender never archives or plaintext-caches a view-once message, the recipient never routes it through ordinary decrypt or media caches, and a temporarily ambiguous commit retains the opened blob in RAM only so confirmation can be retried without replaying the Ratchet. User deletion and remote deletion purge plaintext indexes, capsules, media keys, decrypted object URLs and in-memory decrypt outcomes.

## Stage 8 invariant

Push notifications are content-blind: clients select a bounded event kind and the server constructs a fixed generic title, body, route and tag. Peer-message plaintext is never accepted by moderation, AI, logging or notification functions. Persistent crypto diagnostics contain only bounded error codes, stages, booleans and counters; raw exceptions, stacks, UUIDs, user agents, URLs, ciphertext, keys and arbitrary metadata are discarded. In-memory E2EE traces apply the same identifier-free contract. Messaging, Sealed Sender and call functions log only stable diagnostic codes and numeric status metadata.

## Current checkpoint

- Stages 1, 2, 3, 4, 5, 6, 7 and 8 are complete and validated.
- Stage 8 passed its generic-push, server-error redaction, crypto-log redaction, identifier-free trace and architecture tests, typecheck, the full test suite and the production build.
- The clean Stage 8 implementation commit is `0443d5a`.
- Realtime insert, cross-device consumption and remote deletion paths fail closed and purge local state.
- View-once documents are rejected; only encrypted photos and videos use the one-time path.
- Temporary payloads and one-shot workflows have been removed.
- The pull request remains draft and unmerged.
- No Supabase migration from this rebuild has been applied.
