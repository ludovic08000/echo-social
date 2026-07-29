# Aegis Server architecture

## Security boundary

Aegis Server owns delivery, not decryption.

- Clients own Ed25519/X25519 identities, ratchet state and plaintext.
- `aegis_send_message` validates one stable route version and atomically stores
  the encrypted parent plus exactly one capsule for every authorized device.
- `aegis_sync_device` exposes only pending capsules for the authenticated
  `(UserID, DeviceID)`.
- A client calls `aegis_ack_device_messages` only after authenticated
  decryption and durable local persistence.
- R2 stores only encrypted media/document bytes.

## Current deployment

```text
ForSure client
  -> Supabase Auth JWT
  -> Supabase RPC / PostgreSQL Aegis queue
  -> Supabase Realtime wake-up
  -> R2 encrypted attachments
```

The client uses this mode when `VITE_AEGIS_SERVER_URL` is absent.

## VPS-ready deployment

```text
ForSure client
  -> HTTPS aegis.forsure.social
  -> stateless Aegis gateway
  -> Supabase RPC / PostgreSQL Aegis queue
```

Set:

```dotenv
VITE_AEGIS_SERVER_URL=https://aegis.forsure.social
```

The gateway forwards the caller's bearer token. It has no service-role key,
private device key, media key or plaintext access.

## Later self-hosting

The public protocol boundary contains only:

- `POST /v1/rpc/aegis_send_message`
- `POST /v1/rpc/aegis_sync_device`
- `POST /v1/rpc/aegis_ack_device_messages`

A future VPS implementation may replace the upstream with self-hosted
PostgreSQL, a push worker and object storage while preserving request/response
formats. No client-side ciphertext migration is required.

## Operational requirements

- TLS is mandatory outside localhost.
- The gateway must be behind Caddy/nginx with request and connection limits.
- The PostgreSQL migration
  `20260728150000_aegis_durable_device_inbox.sql` must be applied first.
- Schedule `aegis_prune_device_inbox()` using a service-role Cron job.
- Never expose Supabase service-role credentials to the gateway or browser.
- Keep registration/revocation in the existing authenticated device RPCs.
- Monitor `SERVER_INBOX_SYNC_FAILED`, `SERVER_INBOX_DELIVERY` and
  `SERVER_INBOX_DURABLE_ACK` trace stages.
