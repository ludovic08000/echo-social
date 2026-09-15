# Aegis + Libsignal messaging architecture

This document describes the only encrypted peer-message path supported by the
application. Aegis provides authenticated device routing and durable delivery;
Libsignal provides per-device session establishment and message-key evolution.

## Security boundary

- Message plaintext, attachment keys and Libsignal session state remain on the
  client.
- Supabase stores account/device authorization proofs, public Libsignal prekey
  bundles, opaque message parents and one encrypted capsule per destination
  device.
- The messaging PIN unlocks the local encrypted store. It is never sent to the
  server and does not derive a peer-session key.
- Aegis account and device signing keys authorize which physical installations
  may publish a route. They are separate from Libsignal session keys.

## Runtime implementations

- Browsers load the checked-in Libsignal WASM module.
- Android and iOS call the native Libsignal bridge.
- Both implementations expose the same narrow session API and persist the
  updated session before returning ciphertext or releasing plaintext.
- Unsupported wire formats fail closed; there is no alternate peer-message
  decryptor.

## Device provisioning and routing

1. Aegis assigns and authorizes a stable DeviceID.
2. The device provisions its Libsignal identity, signed prekey and one-time
   prekeys locally.
3. The public bundle is published for that exact authorized DeviceID.
4. The server marks the route ready only when the Aegis trust chain and matching
   Libsignal bundle are both present.
5. A sender resolves a fresh, authenticated device list before creating fan-out.

A revoked, repairing, unsigned or bundle-less device is not a secure target.
Routing never falls back to an unauthenticated table read.

## Send transaction

1. Allocate one stable message UUID and save the draft in the encrypted outbox.
2. Encrypt the message body or attachment manifest once with a random content
   key and bind its immutable metadata as authenticated data.
3. Create a compact capsule containing that content key and the parent digest.
4. Encrypt one capsule for every exact destination device through Libsignal.
   PQXDH establishes a new session when required; Double Ratchet protects later
   messages.
5. Persist the parent and generated copies in the local outbox before network
   delivery.
6. `aegis_send_message` validates the pinned route and atomically commits the
   parent, complete device-copy set and durable inbox rows.
7. A retry reuses the stable UUID and immutable encrypted request. It never
   encrypts a second logical message for the same send operation.

If exact fan-out cannot be produced, the send remains queued with a secure-route
error. It is never downgraded to plaintext or a weaker crypto path.

## Receive transaction

1. `aegis_sync_device` returns only rows addressed to the authenticated
   `(UserID, DeviceID)` route.
2. The client validates the parent/capsule binding and decrypts the capsule with
   Libsignal.
3. The advanced Libsignal state and authenticated plaintext are committed to the
   sealed local store as one logical operation.
4. Only after durable local persistence does the client ACK the server row.

Duplicate deliveries are idempotent. Authentication failures, replayed keys,
route changes and persistence failures do not produce visible plaintext or an
ACK.

## Concurrency and durability

Per-device provisioning, session mutation and outbox mutation are serialized
across tabs. Browsers use Web Locks when available and a renewable IndexedDB
lease otherwise. A second owner re-reads durable state after acquiring the lock.
Broadcast channels carry refresh metadata only, never message content or keys.

Pending and failed outbox rows remain encrypted and durable until an
authoritative receipt is recorded or the user explicitly removes them.

## Verification gates

The release gates cover:

- browser WASM and native bridge contract tests;
- PQXDH first-message and Double Ratchet continuation paths;
- complete multi-device fan-out and route-change retry;
- send idempotency, durable sync, decrypt-before-ACK and replay rejection;
- TypeScript, unit/integration tests and production build.

Public wording states that the application uses Libsignal. It does not claim
affiliation with or certification by Signal.
