import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('supabase/migrations/20260804154000_aegis_durable_database.sql'),
  'utf8',
).toLowerCase();

const inboxClient = readFileSync(
  resolve('src/lib/messaging/aegisDeviceInbox.ts'),
  'utf8',
);

const transport = readFileSync(
  resolve('src/lib/messaging/aegisTransport.ts'),
  'utf8',
);

function section(start: string, end: string): string {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

function withoutSqlLineComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

describe('Aegis durable database migration', () => {
  it('stores delivery state separately without duplicating ciphertext or secrets', () => {
    const table = section(
      'create table if not exists public.aegis_device_inbox',
      'alter table public.aegis_device_inbox enable row level security',
    );
    const tableDefinition = withoutSqlLineComments(table);

    expect(tableDefinition).toContain('copy_id uuid primary key');
    expect(tableDefinition).toContain('references public.message_device_copies(id) on delete cascade');
    expect(tableDefinition).toContain("check (state in ('pending', 'acked'))");
    expect(tableDefinition).toContain('unique (message_id, recipient_user_id, recipient_device_id)');
    expect(tableDefinition).not.toContain('encrypted_body');
    expect(tableDefinition).not.toContain('ciphertext');
    expect(tableDefinition).not.toContain('plaintext');
    expect(tableDefinition).not.toContain('private_key');
    expect(tableDefinition).not.toContain('recovery_secret');
  });

  it('closes direct table access and provides bounded indexes', () => {
    expect(migration).toContain('alter table public.aegis_device_inbox enable row level security');
    expect(migration).toContain('revoke all on table public.aegis_device_inbox');
    expect(migration).toContain('aegis_device_inbox_pending_idx');
    expect(migration).toContain('aegis_device_inbox_expiry_idx');
    expect(migration).toContain("where state = 'pending'");
  });

  it('atomically enqueues every inserted device copy and backfills existing copies', () => {
    expect(migration).toContain('create or replace function public.trg_aegis_enqueue_device_copy');
    expect(migration).toContain('after insert on public.message_device_copies');
    expect(migration).toContain('for each row');
    expect(migration).toContain('from public.message_device_copies copy');
    expect(migration).toContain('on conflict (copy_id) do nothing');
  });

  it('syncs only the authenticated routable device with a bounded batch', () => {
    const sync = section(
      'create or replace function public.aegis_sync_device',
      'create or replace function public.aegis_ack_device_messages',
    );

    expect(sync).toContain('v_uid uuid := auth.uid()');
    expect(sync).toContain('public.get_sesame_device_list(v_uid)');
    expect(sync).toContain('device.device_id = v_device_id');
    expect(sync).toContain('device.is_routable = true');
    expect(sync).toContain('inbox.recipient_user_id = v_uid');
    expect(sync).toContain('inbox.recipient_device_id = v_device_id');
    expect(sync).toContain("inbox.state = 'pending'");
    expect(sync).toContain('least(greatest(coalesce(p_limit, 100), 1), 250)');
    expect(sync).toContain('for update of inbox skip locked');
  });

  it('acks idempotently only for the authenticated device', () => {
    const ack = section(
      'create or replace function public.aegis_ack_device_messages',
      'create or replace function public.aegis_prune_device_inbox',
    );

    expect(ack).toContain('inbox.recipient_user_id = v_uid');
    expect(ack).toContain('inbox.recipient_device_id = v_device_id');
    expect(ack).toContain('inbox.message_id = any(p_message_ids)');
    expect(ack).toContain("set state = 'acked'");
    expect(ack).toContain('acked_at = coalesce(inbox.acked_at, now())');
    expect(ack).toContain('array_length(p_message_ids, 1) > 250');
  });

  it('keeps pruning unavailable to browser clients', () => {
    expect(migration).toContain("auth.role() <> 'service_role'");
    expect(migration).toContain('revoke all on function public.aegis_prune_device_inbox()');
    expect(migration).toContain('from public, anon, authenticated');
    expect(migration).toContain('to service_role');
  });
});

describe('Aegis durable inbox client wiring', () => {
  it('routes send, sync and ack through the stable Aegis transport', () => {
    expect(transport).toContain("| 'aegis_sync_device'");
    expect(transport).toContain("| 'aegis_ack_device_messages'");
    expect(inboxClient).toContain("callAegisServer<AegisInboxRow[]>(\n      'aegis_sync_device'");
    expect(inboxClient).toContain("callAegisServer<number>(\n      'aegis_ack_device_messages'");
  });

  it('does not enumerate conversation messages or read sealed copies directly', () => {
    expect(inboxClient).not.toContain(".from('messages')");
    expect(inboxClient).not.toContain('get_device_copies_for_messages');
    expect(inboxClient).not.toContain(".from('message_device_copies')");
    expect(inboxClient).not.toContain(".from('aegis_device_inbox')");
  });

  it('acks only after resolving the current authorized DeviceID', () => {
    expect(inboxClient).toContain('const ready = await ensureAegisDeviceReady(userId)');
    expect(inboxClient).toContain('p_device_id: ready.deviceId');
    expect(inboxClient).toContain('SERVER_INBOX_DURABLE_ACK');
  });
});
