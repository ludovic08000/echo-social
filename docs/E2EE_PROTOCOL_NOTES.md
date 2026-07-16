# E2EE protocol notes

Crypto and messaging changes must be checked against the current protocol references before editing source code.

References:

- Signal X3DH: https://signal.org/docs/specifications/x3dh/
- Signal Double Ratchet: https://signal.org/docs/specifications/doubleratchet/
- Signal Sesame: https://signal.org/docs/specifications/sesame/
- WhatsApp Encryption Overview / Security Whitepaper: official WhatsApp security documentation

Project rules:

1. Device-copy bootstrap messages are X3DH/Sesame initiation messages.
2. New outbound initiation traffic uses the repeatable `x3dh5.init.v3` pre-key envelope.
3. Every v3 initiation envelope contains a fresh Double Ratchet ciphertext. It never reuses an old message key and never claims a new OPK for each message.
4. The repeatable header binds sender and recipient user/device ids, both identity keys, session id, ephemeral key, SPK id, optional OPK id, and the complete inner ratchet ciphertext through an HMAC key derived from the X3DH secret.
5. All outbound messages remain initiation messages until the initiating device successfully decrypts a ratchet message from the peer on that device pair.
6. Initiation is bounded to 100 outbound messages or seven days. An unacknowledged session beyond either limit is replaced with a fresh X3DH session.
7. A recipient without the session derives it from the repeated X3DH header, verifies the header authenticator, persists the responder session, and then decrypts the inner Double Ratchet message.
8. A recipient that already has the matching session ignores bootstrap reinitialization and decrypts only the inner Double Ratchet message, preserving out-of-order and skipped-message-key handling.
9. Old `x3dh5.init.v2` and legacy `x3dh5.init` messages remain readable but are not emitted for new traffic.
10. Failed authentication must abort the decrypt path, cancel the replay reservation, and restore the previous pair state.
11. X3DH replay handling is two-phase: reserve before DH, finalize only after authenticated inner-ratchet decryption and durable responder-session persistence, cancel on failure.
12. A device OPK private key is deleted only after replay finalization succeeds.
13. Session state stays scoped to self user/device and peer user/device.
14. The client fan-out route cache is never authoritative. The server compares the supplied route against the current canonical signed device list.
15. `E2EE_DEVICE_LIST_STALE` causes one bounded rebuild/retry with the same message UUID. A second change remains visible in the outbox; it never loops.
16. Every target session and initiating-envelope record is snapshotted before outbound encryption. Explicit server rejection restores both; successful commit discards the snapshot.
17. An ambiguous network failure is confirmed idempotently with the same message UUID before any rollback decision.
18. A canonical device list has exactly one active, approved, non-stale primary linked to the canonical Ed25519 account root. Zero or multiple primaries fail closed.

Current outbound repeatable format:

```text
x3dh5.init.v3.<sessionId>.<ekB64>.<spkId>.<opkIdOr0>.<senderIdentityKeyB64>.<recipientIdentityKeyB64>.<innerRatchetB64>.<tagB64>
```

The decoded `innerRatchetB64` value is a normal v5 Double Ratchet message:

```text
x3dh5.<sessionId>.<dhPubB64>.<Ns>.<PN>.<ivB64>.<ctB64>
```

Previous AAD-protected read-only format:

```text
x3dh5.init.v2.<ivB64>.<ctB64>.<ekB64>.<spkId>.<opkIdOr0>.<senderIdentityKeyB64>.<recipientIdentityKeyB64>
```

Legacy read-only format:

```text
x3dh5.init.<ivB64>.<ctB64>.<ekB64>.<spkId>[.<opkId>]
```
