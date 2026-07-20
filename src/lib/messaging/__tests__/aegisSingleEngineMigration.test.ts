import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260720163000_aegis_single_outbound_engine.sql'),
  'utf8',
).toLowerCase();
const lifecycle = readFileSync(
  resolve(root, 'src/lib/device-manager/lifecycle.ts'),
  'utf8',
).toLowerCase();
const queueHook = readFileSync(resolve(root, 'src/hooks/useMessageQueueSignal.ts'), 'utf8');
const mutationHook = readFileSync(resolve(root, 'src/hooks/useMessages.ts'), 'utf8');

describe('Aegis single-engine cutover', () => {
  it('removes the parallel edit-copy protocol', () => {
    expect(migration).toContain('drop function if exists public.send_message_edit_with_device_copies');
    expect(migration).toContain('drop table if exists public.message_edit_device_copies cascade');
    expect(migration).toContain('drop table if exists public.message_edits cascade');
  });

  it('makes device lifecycle writes RPC-only', () => {
    expect(migration).toContain('revoke insert, update, delete on table public.user_devices');
    expect(migration).toContain('create or replace function public.revoke_user_device');
    expect(lifecycle).not.toContain(".from('user_devices').upsert");
    expect(lifecycle).toContain('device_registration_rpc_required');
  });

  it('routes every encrypted UI send through the canonical engine', () => {
    expect(queueHook).toContain('sendAegisOutboundMessage');
    expect(mutationHook).toContain('sendAegisOutboundMessage');
    expect(existsSync(resolve(root, 'src/lib/messaging/sendAegisMessage.ts'))).toBe(false);
  });
});
