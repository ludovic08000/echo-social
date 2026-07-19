# Aegis v1 E2EE protocol notes

Aegis uses standard cryptographic building blocks but owns one small,
application-specific wire contract. It is not wire-compatible with Signal.

References used for security invariants:

- Signal X3DH: https://signal.org/docs/specifications/x3dh/
- Signal Double Ratchet: https://signal.org/docs/specifications/doubleratchet/

## Hard-cutover rules

1. A peer message has one stable UUID shared by the parent ciphertext, every
   device capsule, the local outbox and delivery receipts.
2. The plaintext is encrypted once with a random AES-256-GCM content key.
3. The content key, never the message plaintext, is wrapped independently for
   every authenticated recipient device and every other authenticated sender
   device.
4. Each device pair owns one X25519/X3DH bootstrap and one Double Ratchet
   session. Ratchet operations are serialized per device pair.
5. The parent and the complete canonical set of device capsules are committed
   atomically by `aegis_send_message`.
6. The server derives the expected route from signed, approved, active devices;
   it never trusts a client-supplied device list.
7. `E2EE_DEVICE_LIST_STALE` permits one rebuild with the same UUID, ciphertext
   and content key. It never causes the parent plaintext to be re-encrypted.
8. An explicit server rejection restores all ratchet snapshots. An ambiguous
   network failure is confirmed idempotently with the same UUID.
9. Unknown parent or device-copy formats fail closed. There is no compatibility
   reader and no downgrade to direct message encryption.
10. Device identities, device KX keys, signed prekeys and one-time prekeys are
    durable. Message queues, plaintext cache and ratchet sessions from before
    Aegis v1 are purged and are not restored from backup.

## Wire formats

Parent messages are JSON envelopes with protocol `forsure-aegis-message`,
version `1`, AES-256-GCM ciphertext, UUID bindings and a SHA-256 digest.

An established device session emits:

```text
aegis1.ratchet.<sessionId>.<dhPubB64>.<Ns>.<PN>.<ivB64>.<ciphertextB64>
```

A new device session emits an authenticated bootstrap envelope:

```text
aegis1.init.v1.<sessionId>.<ephemeralKeyB64>.<signedPrekeyId>.<oneTimePrekeyIdOr0>.<senderIdentityKeyB64>.<recipientIdentityKeyB64>.<innerRatchetB64>.<tagB64>
```

No other peer-message or device-capsule prefix is accepted.
