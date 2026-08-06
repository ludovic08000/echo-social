# ADR-0001 — Device enrollment security and non-regression policy

- Status: Accepted
- Date: 2026-08-06
- Scope: Echo Social E2EE device enrollment, approval, routing readiness, and maintenance policy

## Context

A device must never become trusted or routable merely because public key material was uploaded. The enrollment flow must prove both that the account authorizes the device and that the browser or native client actually possesses the private signing key associated with the submitted device public key.

The approval decision must also be bound to the exact enrollment challenge that was created, completed, and verified. A historical or unrelated consumed challenge must never satisfy a new approval attempt.

## Decision

The canonical enrollment flow is:

1. The server creates an enrollment challenge and assigns the DeviceID.
2. The client generates or loads the local device key material.
3. The account identity signs the device authorization payload.
4. The device signing key signs a canonical proof-of-possession payload containing the exact challenge identifier, nonce, user ID, DeviceID, and submitted public keys.
5. Enrollment completion stores the public material and consumes the exact challenge, while leaving the device `pending`, inactive, and unroutable.
6. An authenticated server-side verifier validates:
   - the account identity binding signature;
   - the account authorization signature for the device;
   - the device proof-of-possession signature;
   - the exact challenge identifier, nonce, ownership, expiry, consumed state, and non-cancelled state.
7. A service-role-only finalizer re-locks and compares the exact verified account, device, proof, and challenge values before changing the device to `approved` and active.
8. Signed prekeys and one-time prekeys are published only after approval.
9. The route becomes `ready` only after a valid, active, non-expired signed prekey exists.
10. Message sending remains fail-closed when the current device or any recipient route does not satisfy the E2EE invariants.

## Required invariants

- A client-accessible RPC must never directly approve or reactivate a device.
- `register_user_device_safe` may stage enrollment material only; it must not mark a new or incomplete device as approved.
- Device authorization and device proof of possession are separate requirements.
- The device must prove possession of its own private signing key; it must not self-authorize.
- Approval must reference one exact challenge ID, not merely any consumed challenge for the same device.
- The finalizer must be executable only by the server service role.
- The finalizer must compare the same immutable values verified by the server-side verifier under a transaction lock.
- Revoked, rejected, stale, inconsistent, or locally unrecoverable devices must never be silently repaired by replacing their identity.
- Existing approved devices with coherent local keys and valid routing material must remain compatible.
- No change to enrollment may weaken message encryption, ratchet state, fan-out completeness, route-version checks, outbox durability, or atomic message writes.

## Non-regression policy

Every code change in this area must:

1. Be incremental and scoped to a documented invariant.
2. Preserve a restorable Git reference before risky migrations or protocol changes.
3. Preserve existing public contracts unless an explicit migration and compatibility path are included.
4. Add or update automated tests for the changed invariant and for previously working behavior.
5. Pass lint, type checking, focused cryptographic tests, the full test suite, and the production build before merge.
6. Never silence, skip, weaken, or delete a failing security or regression test merely to make CI green.
7. Never merge or deploy automatically while a required check is failing or unverified.
8. Treat browser storage clearing, key loss, challenge replay, concurrent contexts, and partial deployment as explicit failure cases.
9. Fail closed on ambiguity rather than inventing or reconstructing secret material.

## Consequences

This design adds one device-generated signature and binds approval to one exact challenge. It slightly increases enrollment complexity, but removes two material weaknesses: approval without proof of private-key possession and approval based on an unrelated historical challenge.

The message protocol and ratchet format remain unchanged.
