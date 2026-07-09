# Sesame protocol layer

This folder is the administration entry point for ForSure's multi-device E2EE protocol.

It owns:
- device list resolution and trust gating;
- Sesame-style session routing per peer device;
- inbound message routing and bounded retries;
- fallback/session probing for out-of-order or restored devices;
- message retry/refanout coordination.

The low-level primitives stay in `src/lib/crypto`:
- `deviceRatchet.ts` for Double Ratchet state and v5 envelopes;
- `x3dh.ts` for X3DH prekey bootstrap;
- `secureMessagePipeline.ts` for envelope validation;
- `plaintextStore.ts` for local post-decrypt cache;
- `transparencyLog.ts` for key transparency verification.

Use `@/lib/sesame` for app-level protocol routing and `@/lib/sesame/crypto`
when an admin/debug surface needs grouped access to the underlying primitives.
