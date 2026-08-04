# Aegis live four-device Double Ratchet validation

Executed successfully on 2026-08-05 against the Lovable Cloud database and the shared Aegis gateway core.

## Scope

- two disposable anonymous users;
- two independently registered devices per user: `A1`, `A2`, `B1`, `B2`;
- production `deviceRatchet` implementation;
- real X25519 ECDH-derived bootstrap secrets and independent session state per ordered device pair;
- live durable `aegis_send_message`, `aegis_sync_device` and `aegis_ack_device_messages` RPCs;
- no service-role key.

Run ID: `8c636f3e-9a15-421f-a1f6-d612b2972760`

GitHub Actions run: `30956861107`

## First logical message

Sender: `A1`

Plaintext used by the client test:

`Message clair A1 vers tous les appareils — Double Ratchet validé.`

Fan-out targets:

- `A2`;
- `B1`;
- `B2`.

Results:

- three distinct `aegis1.ratchet.*` envelopes generated;
- message committed through Aegis with HTTP 200;
- each target synced its own device capsule;
- each target decrypted the exact plaintext;
- all three plaintext SHA-256 values matched the sender value;
- each target ACKed exactly one delivery;
- each post-ACK sync returned no pending copy for the message.

The B1 capsule was also presented to B2 deliberately. B2 returned `null`, proving that a sibling device cannot decrypt another device's capsule.

## Reverse logical message

Sender: `B2`

Plaintext used by the client test:

`Réponse claire B2 vers les trois autres appareils — synchronisation confirmée.`

Fan-out targets:

- `B1`;
- `A1`;
- `A2`.

Results:

- three additional distinct Double Ratchet envelopes generated;
- message committed through Aegis with HTTP 200;
- all three target devices synced and decrypted the exact plaintext;
- all three plaintext SHA-256 values matched the sender value;
- all three ACKs returned `1`;
- all three post-ACK syncs confirmed no pending copy.

The `B2 → A1` path reused the bidirectional pair that had already processed the earlier `A1 → B2` message. This exercised a reverse-direction Double Ratchet turn rather than a standalone AES round trip.

## Final evidence

- anonymous users: `2`;
- profiles: `2`;
- active devices: `4`;
- logical messages: `2`;
- device copies: `6`;
- distinct ratchet envelopes: `6`;
- exact plaintext decryptions: `6`;
- successful ACKs: `6`;
- ACKed/read inbox rows: `6`;
- pending inbox rows: `0`;
- gateway requests: `20`, all successful;
- scenario duration: `20,873 ms`.

Server-side inspection found:

- plaintext parent rows: `0`;
- plaintext device-copy rows: `0`;
- valid `aegis1.ratchet.*` rows: `6`;
- copies per message: `3` and `3`.

JWTs, private keys, plaintexts, ciphertexts and request bodies were not emitted by gateway logs.

## Bootstrap boundary

This test validates the production Double Ratchet engine after a real X25519 ECDH shared-secret derivation. It does not exercise the complete remote X3DH directory flow involving server-fetched signed prekeys and one-time prekeys. That is a separate bootstrap test; it does not change the validity of the ratchet, fan-out, sync, cleartext recovery and ACK results above.

## Cleanup and deletion hardening

All disposable users, profiles, devices, conversations, messages, copies and inbox rows were removed after verification. Final residual counts were all zero.

Cleanup exposed that route-version triggers attempted to recreate a route after `auth.users` had already been deleted. Migration `20260805004000_aegis_deleted_user_route_guard.sql` now makes route invalidation a safe no-op for deleted Auth users and removes any residual route-version row. The missing-user path was executed successfully and left zero route rows.
