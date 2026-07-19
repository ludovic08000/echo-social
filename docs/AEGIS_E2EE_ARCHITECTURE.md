# Aegis E2EE v1

Aegis is the only peer-message wire format accepted by the client and database.
There is no legacy reader. The development cutover deliberately deletes old
messages so every remaining row follows one contract.

## Security boundary

- The server authenticates accounts, registers devices, signs device routes and
  atomically stores delivery data.
- Plaintext, attachment keys and message content keys never reach the server.
- Account identity keys are portable through the password-protected Aegis Vault.
- A physical device keeps its own DeviceID, private KX key, prekeys and ratchet
  sessions. The server vault never clones those secrets onto another device.
- The six-digit messaging PIN is a device-local UI lock. It never leaves the
  device and never deletes, restores or advances a ratchet.

## Stable identity

One UUID is created before encryption and reused by the local bubble, encrypted
outbox, `messages` row, every `message_device_copies` row, receipts, retries and
bubble archive. The database trigger rejects a parent whose embedded UUID,
conversation or sender differs from the row.

## Send flow

1. Save the plaintext and stable UUID in the encrypted local outbox.
2. Encrypt the text or attachment marker once with a random AES-256-GCM content
   key. Bind UUID, conversation and sender as authenticated data.
3. Build a small key capsule containing that content key and the ciphertext
   digest.
4. Encrypt only the key capsule to every authenticated recipient device and to
   the sender's other devices. Each device pair has an independent X3DH/Double
   Ratchet session.
5. Persist the exact parent and exact device copies in the outbox before network
   delivery.
6. The Aegis Coordinator RPC validates the signed route and atomically inserts
   the parent plus the complete copy set. A retry reuses the same UUID,
   ciphertext and copies.
7. After acknowledgement, write the sender's encrypted bubble archive in the
   background. Local archive latency never keeps the bubble in `sending`.

The content ciphertext does not change when a ratchet advances. A ratchet
failure can delay one key capsule, but it cannot turn an already authenticated
bubble into a different or empty message.

## Receive flow

1. Load recent device copies in one bounded query.
2. Select only the copy addressed to the authenticated DeviceID.
3. Decrypt the capsule once and cache it by user, device, message UUID and exact
   encrypted copy. Remounts cannot advance the same ratchet envelope twice.
4. Verify capsule UUID, conversation, sender and SHA-256 digest against the
   parent, then open AES-256-GCM.
5. Cache plaintext against the exact parent ciphertext and create the
   recipient's encrypted bubble archive.
6. If a device copy is temporarily unavailable, use the authenticated local or
   per-user encrypted archive and retry the copy route after a short bounded
   delay. Never render ciphertext as text.

## Attachments and documents

Images, videos, voice notes, long text and documents remain separately encrypted
object-storage attachments. Their random attachment key and metadata are inside
the Aegis plaintext, so the same device-capsule flow protects messages and every
attachment type without a second message protocol.

## Device enrollment

After an authenticated account session restores the account identity, the
client silently creates or loads a physical-device KX key, calls only the
authenticated registration RPC, publishes a signed prekey and one-time prekeys,
and verifies that the exact DeviceID appears in the signed route. A retained
DeviceID without its private device key is retired and replaced; it is never
silently overwritten.

## Fail-closed rules

- No peer plaintext fallback.
- No parent insert without a complete authenticated device-copy set.
- No unsigned device-list fallback.
- No second encryption after an ambiguous network result.
- No server-side PIN verifier or server-readable keychain.
- No Vite source rewriting of cryptographic or messaging logic.
