import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260720200000_aegis_core_finalization.sql'),
  'utf8',
).toLowerCase();
const lifecycle = readFileSync(
  resolve(root, 'src/lib/device-manager/lifecycle.ts'),
  'utf8',
).toLowerCase();
const queueHook = readFileSync(resolve(root, 'src/hooks/useAegisMessageQueue.ts'), 'utf8');
const mutationHook = readFileSync(resolve(root, 'src/hooks/useMessages.ts'), 'utf8');
const chatView = readFileSync(resolve(root, 'src/components/messages/ChatView.tsx'), 'utf8');
const chatWidget = readFileSync(resolve(root, 'src/components/ChatWidget.tsx'), 'utf8');
const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');

describe('Aegis single-engine cutover', () => {
  it('removes the parallel edit-copy protocol', () => {
    expect(migration).toContain('drop function if exists public.send_message_edit_with_device_copies');
    expect(migration).toContain('drop function if exists public.send_message_with_device_copies');
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
