# Device bundle contract

For Signal/Sesame-style messaging, every approved active contact device must expose a complete and coherent X3DH bundle before it can receive encrypted messages.

Required for each approved active device:

- identity key present
- device public key present
- current signed prekey present
- signed prekey id present
- signed prekey signature present
- signature validates against the account/device signing identity
- stale/revoked/invalid devices are excluded from fanout targets

If a device does not satisfy the contract, send must not wait for a long bootstrap attempt. The device must be marked repair-required and the message must stay local pending until the contact republishes a valid bundle.
