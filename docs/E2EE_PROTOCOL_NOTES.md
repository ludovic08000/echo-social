# E2EE protocol notes

Crypto and messaging changes must be checked against the current protocol references before editing source code.

References:

- Signal X3DH: https://signal.org/docs/specifications/x3dh/
- Signal Double Ratchet: https://signal.org/docs/specifications/doubleratchet/
- Signal Sesame: https://signal.org/docs/specifications/sesame/
- WhatsApp Encryption Overview / Security Whitepaper: official WhatsApp security documentation

Project rules:

1. Device-copy bootstrap messages are X3DH/Sesame initiation messages.
2. New `x3dh5.init` outbound traffic uses AEAD additional authenticated data.
3. The AAD binds sender user id, sender device id, sender identity key, recipient user id, recipient device id, recipient identity key, ephemeral key, SPK id, and OPK id when present.
4. Old `x3dh5.init` messages stay readable through a legacy reader.
5. New outbound writes must use the v2 bootstrap format.
6. Session state stays scoped to self user/device and peer user/device.
7. Failed AEAD authentication must abort the decrypt path and must not commit new session state.
8. The client fan-out route cache is never authoritative. The server compares the supplied route against the current canonical signed device list.
9. `E2EE_DEVICE_LIST_STALE` causes one bounded rebuild/retry with the same message UUID. A second change remains visible in the outbox; it never loops.
10. Every target session is snapshotted before outbound encryption. Explicit server rejection restores the snapshot; successful commit discards it.
11. An ambiguous network failure is confirmed idempotently with the same message UUID before any rollback decision.
12. X3DH replay handling is two-phase: reserve before DH, finalize only after AEAD authentication and durable responder-session persistence, cancel on failure.
13. A device OPK private key is deleted only after replay finalization succeeds.
14. A canonical device list has exactly one active, approved, non-stale primary linked to the canonical Ed25519 account root. Zero or multiple primaries fail closed.

Current new bootstrap format:

```text
x3dh5.init.v2.<ivB64>.<ctB64>.<ekB64>.<spkId>.<opkIdOr0>.<senderIdentityKeyB64>.<recipientIdentityKeyB64>
```

Legacy read-only format:

```text
x3dh5.init.<ivB64>.<ctB64>.<ekB64>.<spkId>[.<opkId>]
```

## Known protocol limitation — not claimed as implemented

The WhatsApp multi-device design keeps session-setup information available on subsequent outbound messages until the peer has replied and the session is confirmed. The current `x3dh5.init.v2` format creates one bootstrap copy and then uses the persisted Double Ratchet session.

The application now handles rejected sends transactionally and can refan-out/retry a missing copy, but it does **not yet** embed a repeatable bootstrap header in every pre-acknowledgement ratchet message. Implementing that safely requires a versioned envelope containing reusable initiation metadata plus an explicit peer-session acknowledgement; it must not claim or consume a fresh OPK for every message.

Until that format exists:

- the same bootstrap copy may be retried/refan-out with the same message id;
- rejected attempts restore sender session state;
- missing device copies request bounded refan-out;
- no code may claim that repeated WhatsApp-style pre-ack initiation is complete.
