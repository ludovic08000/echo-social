# Audit Signal / Sesame — hardening direct des sources

Sesame is not wire-compatible with the official Signal clients and does not claim certification by Signal. This patch aligns the custom WebCrypto/Supabase implementation with selected X3DH and Double Ratchet security invariants.

## Corrected invariants

- X3DH one-time prekeys are finalized only after AEAD authentication and durable ratchet persistence.
- New device-pair sessions authenticate the complete Double Ratchet header (DH public key, previous-chain count and message number). Existing v5 sessions remain readable until they naturally re-bootstrap.
- Ratchet state persistence is fail-closed; a message is not emitted after an unpersisted chain-key advance.
- The IndexedDB plaintext cache binds ciphertext to its row identifier with AES-GCM AAD. Its hot mirror is RAM-only, never sessionStorage.
- Linked-device transfer no longer exports a decrypted plaintext cache.
- Unsigned raw device lists are no longer accepted as a recipient-routing authority.
- X3DH and device-ratchet security changes now live in checked-in source rather than Vite string transforms.

## Deliberate architecture differences

- React, Supabase and IndexedDB replace Signal Desktop's Electron/SQL/service stack.
- Separate X25519 transport and Ed25519 signing keys are used and pinned through Sesame's canonical identity root.
- Encrypted same-device session durability in Supabase remains a Sesame feature; the server receives only client-side ciphertext.
