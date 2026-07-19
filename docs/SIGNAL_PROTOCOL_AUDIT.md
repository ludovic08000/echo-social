# Audit Signal / Aegis — hardening direct des sources

Aegis is not wire-compatible with the official Signal clients and does not claim certification by Signal. This patch aligns the custom WebCrypto/Supabase implementation with selected X3DH and Double Ratchet security invariants.

## Corrected invariants

- X3DH one-time prekeys are finalized only after AEAD authentication and durable ratchet persistence.
- Device-pair sessions authenticate the complete Double Ratchet header (DH public key, previous-chain count and message number). Earlier wire formats are rejected.
- Ratchet state persistence is fail-closed; a message is not emitted after an unpersisted chain-key advance.
- The IndexedDB plaintext cache binds ciphertext to its row identifier with AES-GCM AAD. Its hot mirror is RAM-only, never sessionStorage.
- Linked-device transfer no longer exports a decrypted plaintext cache.
- Legacy PIN linking no longer clones Double Ratchet sessions; every physical device establishes fresh sessions.
- Unsigned raw device lists are no longer accepted as a recipient-routing authority.
- X3DH and device-ratchet security changes now live in checked-in source rather than Vite string transforms.

## Deliberate architecture differences

- React, Supabase and IndexedDB replace Signal Desktop's Electron/SQL/service stack.
- Separate X25519 transport and Ed25519 signing keys are used and pinned through Aegis's canonical identity root.
- Encrypted same-device session durability in Supabase remains a Aegis feature; the server receives only client-side ciphertext.
