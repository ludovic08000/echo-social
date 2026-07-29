
# Aegis modular architecture

Aegis is split into explicit runtime modules. The first refactor preserves the
existing multi-device protocol, RPCs, durable outbox and LiveKit key format.

- `core`: orchestration, dependency injection, error model and outbox state machine.
- `device`: stable DeviceID readiness and conversation fingerprint trust.
- `crypto`: pure parent-envelope creation; no Supabase or UI imports.
- `routing`: canonical route fan-out and ratchet rollback.
- `transport`: long-message preparation and the atomic Aegis RPC.
- `queue`: encrypted local outbox, plaintext cache and conversation serialization.
- `recovery`: PIN backup and optional archive backup only. It does not repair routes.
- `calls`: LiveKit call-key wrapping, independent from the message outbox.
- `compatibility`: legacy envelope and per-device wire detection.

`src/lib/messaging/aegisOutboundEngine.ts` is retained as a compatibility
adapter. New code imports the public API from `@/lib/aegis`.

The outbound transaction receives `AegisRuntimeDependencies`; individual
modules can therefore be tested or replaced without rewriting the UI hook.
