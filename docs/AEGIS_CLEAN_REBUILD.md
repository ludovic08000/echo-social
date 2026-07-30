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

1. ✅ Baseline architecture and executable protocol tests.
2. ✅ Idempotent message transaction and authoritative send receipt.
3. ✅ Device identity, X3DH, Double Ratchet and complete fan-out.
4. Cross-tab locking and durable encrypted outbox.
5. Call-scoped LiveKit rooms, invitations and per-device call-key delivery.
6. Recovery vault and non-destructive key restore.
7. View-once consumption, deletion and local-cache cleanup.
8. Privacy boundaries for logs, push notifications and server functions.
9. One clean SQL reset for development data and obsolete Aegis objects.
10. Full CI and manual two-account, multi-device and group-call verification.

## Stage 2 invariant

One stable message UUID identifies one immutable encrypted request. Calls for that UUID are serialized in PostgreSQL. A timeout or malformed success response keeps the Ratchet and encrypted outbox pending; only an exact authoritative commit receipt clears them. An explicit rejection may rewind state only after the serialized server call has finished.

## Stage 3 invariant

Every installation is authorized by the stable account identity. The canonical registry retains revoked identities only to verify delayed initial messages, while `is_routable` is required for new sends, prekey claims and device copies. X3DH verifies the account binding, device authorization and signed prekey before establishing a session. Destructive one-time-prekey claims require both conversation participants and the current authorized sender device. Each device pair owns an independent Double Ratchet session with bounded skipped keys, replay rejection and out-of-order delivery. The complete registry is verified before any fan-out mutation, and fan-out is complete or rejected.

## Current checkpoint

- Stages 1, 2 and 3 are complete and validated.
- Typecheck, targeted protocol tests, the full test suite, the build and the Crypto Test Suite passed for stage 3.
- Temporary payloads and one-shot workflows have been removed.
- Stage 4 is the next implementation target.
- The pull request remains draft and unmerged.
- No Supabase migration from this rebuild has been applied.
