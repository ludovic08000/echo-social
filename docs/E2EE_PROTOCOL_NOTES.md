# E2EE protocol notes

Crypto and messaging changes must be checked against the current protocol references before editing source code.

References:

- Signal X3DH: https://signal.org/docs/specifications/x3dh/
- Signal Double Ratchet: https://signal.org/docs/specifications/doubleratchet/
- Signal Sesame: https://signal.org/docs/specifications/sesame/

Project rules:

1. Device-copy bootstrap messages are X3DH/Sesame initiation messages.
2. New x3dh5.init outbound traffic uses AEAD additional authenticated data.
3. The AAD binds sender user id, sender device id, sender identity key, recipient user id, recipient device id, recipient identity key, ephemeral key, SPK id, and OPK id when present.
4. Old x3dh5.init messages stay readable through a legacy reader.
5. New outbound writes must use the v2 bootstrap format.
6. Session state stays scoped to self user/device and peer user/device.
7. Failed AEAD authentication must abort the decrypt path and must not commit new session state.

Current new bootstrap format:

```text
x3dh5.init.v2.<ivB64>.<ctB64>.<ekB64>.<spkId>.<opkIdOr0>.<senderIdentityKeyB64>.<recipientIdentityKeyB64>
```

Legacy read-only format:

```text
x3dh5.init.<ivB64>.<ctB64>.<ekB64>.<spkId>[.<opkId>]
```
