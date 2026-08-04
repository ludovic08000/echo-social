# Aegis Server architecture

## Security boundary

Aegis owns encrypted delivery, not decryption.

- Clients own Ed25519/X25519 account and device identities, Ratchet state,
  plaintext and private keys.
- PostgreSQL stores the encrypted parent, one encrypted capsule per authorized
  device and the minimum delivery metadata required for durable synchronization.
- Aegis never stores plaintext, private device keys, media keys, PIN material or
  recovery secrets in the delivery queue.
- R2 stores encrypted media/document bytes only.
- The gateway forwards the caller's Supabase JWT. It has no service-role key.

## Authoritative PostgreSQL objects

### `public.messages`

Existing canonical message parent. For Aegis messages it contains:

- stable message UUID;
- conversation and sender identifiers;
- encrypted/opaque parent body;
- immutable `aegis_request_digest` for exact idempotency;
- pinned `aegis_route_version`;
- encrypted attachment references and retention metadata.

### `public.message_device_copies`

Existing encrypted capsule table. `aegis_send_message` inserts exactly one row
for each routable recipient device in the same PostgreSQL transaction as the
parent message.

### `public.aegis_device_inbox`

Durable delivery-state table introduced by:

```text
supabase/migrations/20260804154000_aegis_durable_database.sql
```

It references `message_device_copies.id` and stores only:

- recipient `(UserID, DeviceID)`;
- pending/acked state;
- synchronization attempt metadata;
- ACK/read timestamps;
- expiry and retention timestamps.

It deliberately does not duplicate ciphertext or secret material. Deleting a
capsule or parent cascades to the delivery state.

### Device authority

`user_devices`, account identity records, signed prekeys and
`get_sesame_device_list()` remain the source of truth for authorization and
routing. A DeviceID must be active, non-revoked, account-authorized and
cryptographically routable before it may send, sync or ACK.

## Atomic send path

```text
Client prepares one immutable request
  -> aegis_send_message
  -> authenticate auth.uid() and sender DeviceID
  -> lock participant route counters
  -> validate pinned route version
  -> validate exact device fan-out
  -> insert messages parent
  -> insert all message_device_copies
  -> enqueue one aegis_device_inbox row per copy through trigger
  -> commit authoritative receipt
```

The parent, capsules and inbox state commit or roll back together. Reusing the
same message UUID with the same immutable request returns the existing commit
receipt; reusing it with different content is rejected.

## Durable sync path

`aegis_sync_device(p_device_id, p_limit)`:

1. requires `auth.uid()`;
2. verifies that `p_device_id` is a routable device belonging to that account;
3. selects only pending rows for exactly that `(UserID, DeviceID)`;
4. bounds the batch to 1–250 rows;
5. uses `FOR UPDATE SKIP LOCKED` to avoid duplicate concurrent workers;
6. updates delivery-attempt metadata;
7. returns the encrypted capsule and opaque parent required by the client.

Clients have no direct table access to `aegis_device_inbox` or
`message_device_copies`.

## Durable ACK path

The client calls `aegis_ack_device_messages` only after authenticated
decryption and durable local persistence.

The RPC:

- binds the operation to `auth.uid()` and the current routable DeviceID;
- accepts a bounded batch of message UUIDs;
- updates only rows belonging to that exact device;
- is idempotent;
- optionally records read state;
- mirrors timestamps to `message_device_copies` for existing compatibility
  paths.

## RLS and grants

- RLS is enabled on `aegis_device_inbox`.
- No direct policy is granted to browser clients.
- `public`, `anon` and `authenticated` receive no table privileges.
- `authenticated` may execute only the restricted send/sync/ACK RPCs.
- `aegis_prune_device_inbox()` is unavailable to browser roles and reserved for
  service maintenance.

## Current deployment

```text
Echo Social client
  -> Supabase Auth JWT
  -> Supabase RPC / PostgreSQL Aegis queue
  -> Supabase Realtime wake-up
  -> R2 encrypted attachments
```

The client uses direct Supabase RPC when `VITE_AEGIS_SERVER_URL` is absent.

## VPS deployment

```text
Echo Social client
  -> HTTPS aegis.forsure.fans
  -> stateless Aegis gateway
  -> Supabase RPC / PostgreSQL Aegis queue
```

Set:

```dotenv
VITE_AEGIS_SERVER_URL=https://aegis.forsure.fans
```

The public gateway boundary is:

- `POST /v1/rpc/aegis_send_message`
- `POST /v1/rpc/aegis_sync_device`
- `POST /v1/rpc/aegis_ack_device_messages`

The client uses the same payloads in direct-Supabase and gateway modes.

## Applying the database migration

Apply migrations in timestamp order. The required durable inbox migration is:

```text
20260804154000_aegis_durable_database.sql
```

Before production application:

1. take a PostgreSQL backup or Supabase PITR checkpoint;
2. verify the current schema already contains `messages`,
   `message_device_copies`, `user_devices` and `get_sesame_device_list`;
3. apply the migration through the normal Supabase migration workflow;
4. reload the PostgREST schema if the deployment tool does not process the
   included `NOTIFY pgrst`;
5. test send, sync, ACK, revoked-device rejection and a concurrent sync;
6. deploy the client only after all three RPCs are visible.

The migration is additive. It does not truncate messages, conversations,
devices or user data.

## Retention and Cron

`aegis_prune_device_inbox()` deletes, in bounded batches:

- expired device capsules;
- capsules ACKed for more than 30 days;
- expired Aegis parents that no longer have a device capsule.

Schedule it from a trusted Supabase Cron/service context. One example schedule
is hourly:

```sql
select cron.schedule(
  'aegis-prune-device-inbox',
  '17 * * * *',
  $$select public.aegis_prune_device_inbox();$$
);
```

Do not place a service-role credential in the gateway, browser bundle or mobile
application.

## Non-destructive rollback

A rollback must preserve `messages` and `message_device_copies`.

1. Remove `VITE_AEGIS_SERVER_URL` to return the client to direct Supabase RPC.
2. Roll back the client code to the previous inbox lookup path if required.
3. Stop the Cron job.
4. Drop only the new trigger, RPCs and `aegis_device_inbox` table after confirming
   no client still calls them.
5. Keep the compatibility `delivered_at` and `read_at` columns; they are benign
   and avoid destructive column removal.

Suggested SQL rollback order:

```sql
drop trigger if exists aegis_enqueue_device_copy on public.message_device_copies;
drop function if exists public.trg_aegis_enqueue_device_copy();
drop function if exists public.aegis_sync_device(text, integer);
drop function if exists public.aegis_ack_device_messages(text, uuid[], boolean);
drop function if exists public.aegis_prune_device_inbox();
drop table if exists public.aegis_device_inbox;
```

## Monitoring

Monitor metadata-only stages:

- `SERVER_INBOX_SYNC_FAILED`;
- `SERVER_INBOX_DELIVERY`;
- `SERVER_INBOX_DURABLE_ACK`.

Never log ciphertext, JWTs, user identifiers, DeviceIDs, private keys or
recovery material.

## Later self-hosting

A future implementation may replace Supabase PostgreSQL with self-hosted
PostgreSQL, a push worker and object storage while preserving these three HTTP
request/response formats. No client-side ciphertext conversion is required.
