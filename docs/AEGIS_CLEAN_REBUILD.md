# Aegis clean rebuild

This branch rebuilds the messaging and call security architecture directly from `main`.

There is no production compatibility requirement. Test messages, obsolete schemas, unused RPCs and abandoned migrations may be removed.

## Non-negotiable rules

- One active send path.
- One active device model.
- One active wire format.
- One active database schema and one final migration set.
- No legacy fallback or dual reader.
- No rollback of cryptographic state after an ambiguous server result.
- No raw LiveKit call key stored in the database.
- No message plaintext in server logs, push payloads or moderation services.
- Every stage must pass typecheck, targeted tests, full tests and build before the next stage.

## Ordered stages

1. Baseline architecture and executable protocol tests.
2. Idempotent message transaction and authoritative send status.
3. Device identity, X3DH, Double Ratchet and complete fan-out.
4. Cross-tab locking and durable encrypted outbox.
5. Call-scoped LiveKit rooms, invitations and per-device call-key delivery.
6. Recovery vault and non-destructive key restore.
7. View-once consumption, deletion and local-cache cleanup.
8. Privacy boundaries for logs, push notifications and server functions.
9. One clean SQL reset for development data and obsolete Aegis objects.
10. Full CI and manual two-account, multi-device and group-call verification.
