# Aegis live server-assigned DeviceID validation

Executed successfully on 2026-08-05 against the live Lovable Cloud / Supabase project.

## Purpose

Validate the Signal-style two-phase logical-device enrollment added for restored iOS browsers:

1. the authenticated client asks the server for a short-lived challenge;
2. PostgreSQL allocates an opaque `dev_<32 hex>` DeviceID;
3. the client creates device-specific X25519 and Ed25519 keys under that ID;
4. the account signing key authorizes the exact `(user, DeviceID, KX key, signing key)` tuple;
5. the server atomically consumes the nonce and registers the device;
6. the device publishes its signed prekey and one-time prekeys;
7. the route becomes `ready` only after the prekey requirements are satisfied.

GitHub Actions run: `30978705315`

GitHub Actions job: `92218306744`

Scenario run ID: `b89fd712-24c4-4eec-9941-603a257aa715`

## Successful evidence

The live run created one disposable anonymous user and exercised two independent server challenges.

Completed-device path:

- `begin_user_device_enrollment` returned `DEVICE_ENROLLMENT_CHALLENGE_CREATED`;
- the returned DeviceID matched `^dev_[a-f0-9]{32}$`;
- `complete_user_device_enrollment` returned `DEVICE_ENROLLMENT_COMPLETED`;
- a repeated completion returned `DEVICE_ENROLLMENT_ALREADY_COMPLETED`;
- cancellation after a committed-but-possibly-lost response safely returned `DEVICE_ENROLLMENT_ALREADY_COMPLETED`;
- the remote directory verified both the account identity binding and device authorization signature;
- one active signed prekey was published;
- 100 one-time prekeys were published;
- `mark_current_device_route_ready` returned `DEVICE_ROUTE_READY`;
- the final device row had platform `ios`, approval `approved`, active state `true`, route `ready`, no routing error and a non-empty device authorization signature.

Cancelled-device path:

- the server allocated a second, distinct DeviceID;
- a wrong nonce returned `DEVICE_ENROLLMENT_INVALID_NONCE` without consuming the challenge;
- the correct nonce returned `DEVICE_ENROLLMENT_CANCELLED`;
- repeating the cancellation returned `DEVICE_ENROLLMENT_ALREADY_CANCELLED`;
- no `user_devices` row was created for the cancelled DeviceID.

Final scenario summary:

- users: `1` disposable;
- completed devices: `1`;
- cancelled devices: `1`;
- valid server DeviceID format: `true`;
- account binding verification: `true`;
- device authorization verification: `true`;
- completion idempotency: `true`;
- lost-response settlement safety: `true`;
- invalid nonce rejection: `true`;
- cancellation idempotency: `true`;
- final route ready: `true`;
- active signed prekeys: `1`;
- available one-time prekeys: `100`;
- scenario duration: `7,830 ms`;
- Vitest result: `1 passed`.

No JWT, nonce, private key, PIN or key material was emitted by the scenario logs. Device, user, challenge and signed-prekey references were SHA-256-truncated aliases only.

## Cleanup inspection

Before cleanup, PostgreSQL contained exactly:

- one test Auth user;
- one authorized iOS device;
- one active account identity;
- one active signed prekey;
- 100 one-time prekeys;
- two enrollment challenges: one completed and one cancelled.

Deleting the Auth user removed the Auth row and challenge ledger, but exposed that several older public tables do not cascade automatically from `auth.users`. The remaining test-only rows were deleted explicitly by their disposable user ID.

Final residual inspection found:

- Auth users: `0`;
- public tables containing the test user: `0`;
- public rows containing the test user: `0`;
- enrollment challenges: `0`;
- profiles: `0`.

## Boundary still requiring a physical-device test

This validates the live database, real JWT authentication, WebCrypto-compatible account/device signatures, server-assigned DeviceID, prekey publication and route certification. It does not prove that the currently installed iPhone browser bundle invokes the new client flow, because the branch Preview could not be rebuilt while the Vercel daily deployment quota was exhausted.

The remaining acceptance test is therefore the physical Chrome/Safari iOS flow after a deployment containing this branch:

1. restore the account identity;
2. create/unlock the local PIN;
3. confirm a new `dev_…` iOS route appears as `ready`;
4. send iOS → Windows;
5. send Windows → iOS;
6. upload one encrypted image.
