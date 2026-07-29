# Aegis protocol audit v2 — Signal-aligned invariants

Aegis remains a custom WebCrypto/Supabase protocol. It is not Signal wire
compatible and does not currently implement PQXDH, Sparse Post-Quantum Ratchet
or Triple Ratchet.

This hardening release applies the following published Signal-style invariants:

1. A device route is authorized by the stable account Ed25519 key. A server can
   no longer add a self-signed device while leaving the account safety number
   unchanged.
2. Every accepted ratchet session authenticates its DH header. Existing `s6`
   sessions remain readable because they already authenticate the header; new
   sessions use a 128-bit `s7` identifier.
3. Ratchet and repeated-prekey wire inputs are parsed with strict field counts,
   base64 lengths, counter bounds and total-size limits before cryptographic
   state is touched.
4. The parent message envelope and key capsule are likewise bounded and tied to
   UUID identifiers before decryption.
5. Version-1 device rows are retained for migration but excluded from the
   authoritative route until the device re-registers with a version-2 account
   signature. No device is automatically revoked.

The repeated X3DH initial message continues to accompany initiation messages
until the first ratchet response, matching Sesame's recovery guidance. Active
and inactive device-pair sessions remain bounded and delayed messages may
promote a valid inactive session.


## Secure call-key transport

The former group-call path wrote the raw LiveKit key to
`active_calls.encrypted_call_key`. This is removed. New 1:1 and group calls:

- create a fixed call UUID before signaling;
- bind the 32-byte LiveKit key to call, conversation and caller identifiers;
- fan the capsule out only to invited users' version-2 devices through the
  existing X3DH/Double Ratchet device envelopes;
- atomically insert the call and its exact device copies through a security
  definer RPC;
- fetch and decrypt one device copy only when the recipient accepts;
- reject any future group row that attempts to store a non-null database key.

A legacy wrapped-key fallback remains temporarily for old 1:1 callers during a
rolling deployment. There is no legacy group fallback.
