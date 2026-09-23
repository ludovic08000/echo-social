import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function between(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contents.slice(startIndex, endIndex);
}

describe('messaging PIN recovery safety contract', () => {
  it('never sends the messaging PIN to Lovable Cloud', () => {
    const hook = source('src/hooks/useChatPin.ts');
    const edgeFunction = source('supabase/functions/verify-chat-pin/index.ts');

    expect(hook).toContain("body: { action: 'register-local-recovery' }");
    expect(hook).not.toMatch(/register-local-recovery'\s*,\s*pin/);
    expect(edgeFunction).toContain('const { action, code } = body;');
    expect(edgeFunction).toContain('PIN_LOCAL_ONLY');
  });

  it('keeps an email reset isolated from messages and Aegis/Libsignal identities', () => {
    const edgeFunction = source('supabase/functions/verify-chat-pin/index.ts');
    const resetBlock = between(
      edgeFunction,
      'if (action === "confirm-reset")',
      'return new Response(JSON.stringify({ error: `Action inconnue:',
    );

    const forbiddenTargets = [
      '.from("messages")',
      '.from("user_devices")',
      '.from("user_public_keys")',
      '.from("user_backups")',
      'libsignal',
      'identity-keys',
      'wrapped-keys',
    ];

    for (const target of forbiddenTargets) {
      expect(resetBlock).not.toContain(target);
    }
  });

  it('limits local PIN removal to the PIN verifier store', () => {
    const hook = source('src/hooks/useChatPin.ts');
    const removal = between(
      hook,
      'async function removeLocalPin',
      'async function verifyLocalPin',
    );

    expect(removal).toContain('tx.objectStore(STORE).delete(userId)');
    expect(removal).toContain('secureRemoveSecret');
    expect(removal).not.toContain('wrapped-keys');
    expect(removal).not.toContain('identity-keys');
    expect(removal).not.toContain('libsignal');
  });

  it('requires the account Master Key to open portable PIN continuity', () => {
    const vault = source('src/lib/crypto/pinContinuityVault.ts');

    expect(vault).toContain('getSessionMasterKey');
    expect(vault).toContain("name: 'AES-GCM'");
    expect(vault).toContain("if (!masterKey) return 'locked'");
    expect(vault).toContain("if (status === 'locked') return 'master_key_unavailable'");
    expect(vault).not.toContain('pin_hash');
    expect(vault).not.toContain('reset_code_hash');
  });

  it('authenticates the account before accepting any reset action', () => {
    const edgeFunction = source('supabase/functions/verify-chat-pin/index.ts');
    const authCheck = edgeFunction.indexOf('userClient.auth.getUser()');
    const bodyRead = edgeFunction.indexOf('const body = await req.json()');
    const resetAction = edgeFunction.indexOf('if (action === "request-reset")');

    expect(authCheck).toBeGreaterThanOrEqual(0);
    expect(bodyRead).toBeGreaterThan(authCheck);
    expect(resetAction).toBeGreaterThan(bodyRead);
  });
});
