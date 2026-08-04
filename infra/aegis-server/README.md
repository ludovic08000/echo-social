# Aegis Server gateway

This stateless gateway gives Echo Social a stable Aegis HTTP boundary while the
authoritative encrypted queue remains in PostgreSQL/Supabase.

It never receives plaintext or private keys. It forwards the caller's Supabase
JWT to restricted Aegis RPC functions, so `auth.uid()` and all server-side
device checks remain authoritative. The gateway must never receive a Supabase
service-role key.

## Database prerequisite

Apply the migrations in `supabase/migrations` before deploying the client or
gateway. Durable send/sync/ACK requires:

```text
20260804154000_aegis_durable_database.sql
```

This additive migration creates the sealed delivery-state table and restores:

- `aegis_send_message` as the existing atomic encrypted send path;
- `aegis_sync_device` for the authenticated DeviceID's pending queue;
- `aegis_ack_device_messages` for durable, idempotent ACK/read state;
- `aegis_prune_device_inbox` for trusted retention maintenance.

The migration does not truncate messages, conversations, devices or user data.

## HTTP endpoints

```text
GET  /health
POST /v1/rpc/aegis_send_message
POST /v1/rpc/aegis_sync_device
POST /v1/rpc/aegis_ack_device_messages
```

The three RPC routes accept the same JSON payload as Supabase PostgREST RPC.
The gateway forwards the browser/mobile Bearer token and the public anon key to
Supabase; authorization remains inside PostgreSQL.

## Start on a VPS

1. Copy `.env.example` to `.env`.
2. Set `SUPABASE_URL` and the public `SUPABASE_ANON_KEY`.
3. Keep every web/Capacitor origin explicit in `AEGIS_ALLOWED_ORIGINS`.
4. Set a bounded `AEGIS_MAX_BODY_BYTES`; the default is 1 MiB.
5. Run `docker compose up -d --build`.
6. Put Caddy or nginx in front of `127.0.0.1:8787`.
7. Expose the service only through HTTPS, for example
   `https://aegis.forsure.social`.
8. Set `VITE_AEGIS_SERVER_URL=https://aegis.forsure.social` in the client build.

Without `VITE_AEGIS_SERVER_URL`, the same client calls the same Supabase RPCs
directly. This makes gateway deployment reversible and requires no ciphertext
conversion.

## Health check

```sh
curl --fail https://aegis.forsure.social/health
```

Expected body:

```json
{"ok":true,"service":"aegis-server"}
```

The health endpoint confirms only that the Node gateway is running. Complete
readiness also requires testing an authenticated send, sync and ACK against the
current database schema.

## Reverse-proxy controls

TLS is mandatory outside localhost. Configure the reverse proxy with:

- request-size limits equal to or lower than `AEGIS_MAX_BODY_BYTES`;
- connection and per-IP request limits;
- short header/body timeouts;
- no response caching;
- access logs that omit Authorization headers and request bodies.

The Node gateway already applies an upstream timeout, strict route allow-list,
CORS allow-list, `no-store` and `nosniff` headers.

## Retention

Schedule `public.aegis_prune_device_inbox()` from a trusted Supabase Cron or
service context. Never schedule it through the public gateway. Example:

```sql
select cron.schedule(
  'aegis-prune-device-inbox',
  '17 * * * *',
  $$select public.aegis_prune_device_inbox();$$
);
```

## Rollback

1. Remove `VITE_AEGIS_SERVER_URL` and redeploy the client to return to direct
   Supabase RPC.
2. Stop the retention Cron job.
3. Roll back the client inbox implementation if required.
4. Drop only the durable inbox trigger/RPC/table objects documented in
   `docs/AEGIS_SERVER_ARCHITECTURE.md`.
5. Preserve `messages` and `message_device_copies`; no ciphertext migration is
   required.

The first VPS version remains deliberately stateless. A later migration can
move PostgreSQL and notification workers behind the same three endpoints
without changing the web/mobile protocol.
