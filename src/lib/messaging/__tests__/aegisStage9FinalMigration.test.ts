import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDir = resolve(process.cwd(), 'supabase/migrations');
const migrationName = '20260730090000_aegis_clean_rebuild.sql';
const sql = readFileSync(resolve(migrationDir, migrationName), 'utf8').toLowerCase();
const types = readFileSync(resolve(process.cwd(), 'src/integrations/supabase/types.ts'), 'utf8');

describe('Aegis stage 9 final schema migration', () => {
  it('keeps exactly one July 30 Aegis rebuild migration', () => {
    const files = readdirSync(migrationDir)
      .filter((file) => /^20260730.*aegis.*\.sql$/.test(file))
      .sort();
    expect(files).toEqual([migrationName]);
  });

  it('uses one outer transaction and one schema reload', () => {
    expect(sql.match(/^begin;$/gm)).toHaveLength(1);
    expect(sql.match(/^commit;$/gm)).toHaveLength(1);
    expect(sql.match(/notify pgrst, 'reload schema';/g)).toHaveLength(1);
  });

  it('performs the explicit destructive development reset', () => {
    expect(sql).toContain("truncate table public.messages cascade");
    expect(sql).toContain("truncate table public.active_calls cascade");
    expect(sql).toContain("truncate table public.user_devices cascade");
    expect(sql).toContain("truncate table public.user_public_keys cascade");
    expect(sql).toContain("truncate table public.aegis_user_route_versions cascade");
    expect(sql).not.toContain("legacy-call-");
  });

  it('removes raw call-key storage and every obsolete mutation path', () => {
    expect(sql).toContain('drop column if exists encrypted_call_key cascade');
    expect(sql).toContain("'call_signal'");
    expect(sql).toContain("'aegis_ack_device_messages'");
    expect(sql).toContain("'aegis_sync_device'");
    expect(sql).toContain('drop trigger if exists trg_scrub_view_once');
    expect(sql).toContain('revoke insert, update, delete on table public.active_calls');
    const activeInsert = sql.match(/insert into public\.active_calls \([\s\S]*?\) values \([\s\S]*?\);/)?.[0] ?? '';
    expect(activeInsert).not.toContain('encrypted_call_key');
  });

  it('contains every final Aegis table and authoritative RPC', () => {
    for (const token of [
      'create function public.aegis_send_message',
      'create function public.get_sesame_device_list',
      'create function public.register_user_device_safe',
      'create or replace function public.aegis_call_create',
      'create table if not exists public.aegis_call_invitations',
      'create table if not exists public.aegis_recovery_vaults',
      'create table if not exists public.aegis_view_once_payloads',
      'create or replace function public.commit_aegis_view_once_consume',
    ]) expect(sql).toContain(token);
  });

  it('keeps generated types aligned with the current additive schema', () => {
    const activeStart = types.indexOf('      active_calls: {');
    const activeEnd = types.indexOf('      aegis_call_invitations: {', activeStart);
    const active = types.slice(activeStart, activeEnd);
    expect(active).toContain('room_name: string');
    expect(active).toContain('protocol_version: number');
    expect(active).not.toContain('encrypted_call_key');
    expect(types).toContain('      aegis_call_invitations: {');
    expect(types).toContain('      aegis_device_inbox: {');
    expect(types).toContain('      aegis_recovery_vaults: {');
    expect(types).toContain('      aegis_view_once_payloads: {');
    expect(types).toContain('aegis_request_digest: string | null');
    expect(types).toContain('      aegis_sync_device: {');
    expect(types).toContain('      aegis_ack_device_messages: {');
    expect(types).not.toContain('      call_signal: {');
  });
});
