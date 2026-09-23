import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

it('removes retired messenger implementations instead of leaving dormant entry points', () => {
  for (const path of [
    'src/hooks/useMessages.legacy.ts',
    'src/lib/libsignalNative.ts',
    'src/lib/messaging/aegisCryptoEngine.ts',
    'src/lib/messaging/libsignalBundleRegistry.ts',
    'src/lib/messaging/provider.ts',
    'src/lib/crypto/cryptoApi.ts',
    'src/lib/crypto/secureBackupVault.ts',
    'src/lib/matrix/index.ts',
    'src/components/messages/MatrixAttachmentBubble.tsx',
    'supabase/functions/matrix-route/index.ts',
    'supabase/functions/matrix-session/index.ts',
  ]) expect(existsSync(path), path).toBe(false);
});

it('drops the retired Matrix database bridge and removes it from generated types', () => {
  const teardown = read('supabase/migrations/20260923090000_remove_retired_matrix_bridge.sql');
  expect(teardown).toContain('drop function if exists public.claim_matrix_conversation_room');
  expect(teardown).toContain('drop function if exists public.get_matrix_conversation_route');
  expect(teardown).toContain('drop table if exists public.matrix_room_mappings');
  expect(teardown).toContain('drop table if exists public.matrix_user_mappings');

  const generatedTypes = read('src/integrations/supabase/types.ts');
  expect(generatedTypes).not.toContain('matrix_room_mappings');
  expect(generatedTypes).not.toContain('matrix_user_mappings');
  expect(generatedTypes).not.toContain('claim_matrix_conversation_room');
  expect(generatedTypes).not.toContain('get_matrix_conversation_route');
});

it('keeps only the secure send export in the public messaging hook', () => {
  const source = read('src/hooks/useMessages.ts');
  expect(source).toContain("export { useSendMessage } from './useSendMessageSecure'");
  expect(source).toContain('export function useMessages(');
  expect(source).not.toContain('sendToZeus');
  expect(source).not.toContain('export function useSendMessage()');
});

it('keeps Matrix out of direct dependencies and the npm lockfile', () => {
  const manifest = JSON.parse(read('package.json'));
  expect(manifest.dependencies['matrix-js-sdk']).toBeUndefined();
  expect(manifest.dependencies['matrix-encrypt-attachment']).toBeUndefined();
  expect(read('package-lock.json')).not.toContain('matrix-js-sdk');
  expect(read('bun.lock')).not.toContain('matrix-js-sdk');
  expect(read('bun.lock')).not.toContain('matrix-encrypt-attachment');
  expect(read('vite.config.ts')).not.toContain('matrix-runtime');
});

it('routes development diagnostics to the same backend as current messaging', () => {
  const source = read('src/main.tsx');
  expect(source).toContain("import('@/lib/crypto/libsignalPlatformBridge')");
  expect(source).toContain('diagnosticWindow.__libsignalCapabilities = getLibsignalBackendInfo');
  expect(source).not.toContain('libsignalNative');
});

it('retains the AI response storage without pushing plaintext into messenger tables', () => {
  const source = read('supabase/functions/agent-chat/index.ts');
  expect(source).toContain('from("ai_agent_messages")');
  expect(source).not.toContain('pushToMessenger');
  expect(source).not.toMatch(/from\(["']messages["']\)/);
});
