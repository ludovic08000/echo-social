# E2EE device trust hardening

This patch adds a Supabase-backed trusted-device registry for Echo Social.

## Goal

Each browser is treated as a logical device. E2EE send/sync/fanout/backup operations must be blocked until the browser/device is trusted.

## Security rules

- Unknown browser/device: require PIN.
- Revoked or blocked device: block.
- OS change: require PIN.
- Browser change: require PIN.
- Strong location/timezone change: require PIN.
- E2EE fingerprint change: never auto-trust in production.
- Private keys, PINs, decrypted backups and key seeds must never be stored in Supabase.

## Supabase

Run the migration:

```sql
supabase/migrations/20260611120000_add_user_trusted_devices.sql
```

The table stores only public metadata:

- `device_id`
- browser and OS metadata
- hashed user-agent and Client Hints
- approximate location metadata
- E2EE public key/fingerprint
- `trust_status`

## Client integration

Before any encrypted send/sync/fanout/backup:

```ts
import { assertE2EETrustedBrowserDevice } from '@/lib/crypto/e2eeDeviceGate';

await assertE2EETrustedBrowserDevice(user.id);
```

If it throws `PIN_REQUIRED_FOR_NEW_DEVICE` or `PIN_REQUIRED_FOR_RISK_CHANGE`, show the PIN screen.

After PIN validation:

```ts
import { trustCurrentDeviceAfterPin } from '@/lib/security/browserDeviceTrust';

await trustCurrentDeviceAfterPin({
  userId: user.id,
  e2eePublicKey,
  e2eeIdentityFingerprint,
  signature,
});
```

The `signature` should eventually be produced by the account identity key or by a previously trusted device. Until then, a device without signature should be considered compatible but not fully Signal-grade.

## Production requirement

Remove or disable any logic that logs or performs:

```txt
auto-trusting fingerprint
Server fingerprint rotated
LEGACY device list
```

A changed fingerprint must become a blocking security event, not an automatic trust event.
