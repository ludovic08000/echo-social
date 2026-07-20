import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260720200000_aegis_core_finalization.sql'),
  'utf8',
).toLowerCase();
const wireRepair = readFileSync(
  resolve(root, 'supabase/migrations/20260720213000_aegis_device_copy_wire_repair.sql'),
  'utf8',
).toLowerCase();
const lifecycle = readFileSync(
  resolve(root, 'src/lib/device-manager/lifecycle.ts'),
  'utf8',
).toLowerCase();
const queueHook = readFileSync(resolve(root, 'src/hooks/useAegisMessageQueue.ts'), 'utf8');
const mutationHook = readFileSync(resolve(root, 'src/hooks/useMessages.ts'), 'utf8');
const queueFacade = readFileSync(resolve(root, 'src/hooks/useMessageQueue.ts'), 'utf8');
const messageBody = readFileSync(
  resolve(root, 'src/components/messages/DecryptedMessageBody.tsx'),
  'utf8',
);
const chatView = readFileSync(resolve(root, 'src/components/messages/ChatView.tsx'), 'utf8');
const chatWidget = readFileSync(resolve(root, 'src/components/ChatWidget.tsx'), 'utf8');
const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');

describe('Aegis single-engine cutover', () => {
  it('removes the parallel edit-copy protocol', () => {
    expect(migration).toContain('drop function if exists public.send_message_edit_with_device_copies');
    expect(migration).toContain('drop function if exists public.send_message_with_device_copies');
  });

  it('makes the Aegis RPC the only device-copy writer', () => {
    expect(wireRepair).toContain('create or replace function public.is_supported_aegis_device_copy');
    expect(wireRepair).toContain('check (public.is_supported_aegis_device_copy(encrypted_body))');
    expect(wireRepair).toContain('drop policy if exists "sender can insert device copies"');
    expect(wireRepair).toContain('revoke insert on public.message_device_copies from anon, authenticated');
    expect(wireRepair).toContain('delete from public.message_device_copies');
  });

  it('makes device lifecycle writes RPC-only', () => {
    expect(migration).toContain('create function public.revoke_user_device');
    expect(migration).toContain('p_replacement_device_id text default null');
    expect(migration).toContain('set primary_device_id = v_replacement_id');
    expect(migration).toContain('create trigger aegis_reconcile_device_root');
    expect(lifecycle).not.toContain(".from('user_devices').upsert");
    expect(lifecycle).toContain('device_registration_rpc_required');
  });

  it('routes every encrypted UI send through the canonical engine', () => {
    expect(queueHook).toContain('sendAegisOutboundMessage');
    expect(mutationHook).toContain('sendAegisOutboundMessage');
    expect(existsSync(resolve(root, 'src/lib/messaging/sendAegisMessage.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'src/hooks/useMessageQueueSignal.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'src/lib/messaging/signalWebConversationQueue.ts'))).toBe(false);
    expect(viteConfig).not.toContain('useMessagesStable');
  });

  it('removes the Bubble diagnostic channel from the runtime', () => {
    expect(existsSync(resolve(root, 'src/lib/messaging/bubbleDiagnostics.ts'))).toBe(false);
    expect(queueFacade).not.toContain('bubbleDiagnostic');
    expect(messageBody).not.toContain('bubbleDiagnostic');
    expect(queueFacade).not.toContain('__FORSURE_BUBBLE_DEBUG__');
    expect(messageBody).not.toContain('__FORSURE_BUBBLE_DEBUG__');
  });

  it('never interprets cold encryption readiness as plaintext permission', () => {
    expect(queueHook).toContain('const encryptionWasRequired = !allowPlaintext');
    expect(queueHook).not.toContain('isEncryptionActive &&');
    expect(chatView).toContain('const isEncryptionActive = !isZeusConversation');
    expect(chatWidget).toContain('const isEncryptionActive = !isZeusConversation');
  });

  it('keeps clear document metadata out of encrypted peer rows', () => {
    expect(migration).toContain("if new.body_kind = 'multi_device'");
    expect(migration).toContain('new.document_name := null');
    expect(migration).toContain('new.document_mime := null');
    expect(migration).toContain('new.document_size_bytes := null');
  });
});
