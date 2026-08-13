import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPrivacySafePushPayload,
  safeServerErrorMeta,
  sanitizeServerLogMetadata,
} from '../../../../supabase/functions/_shared/aegis-privacy';

const read = (path: string) => fs.readFileSync(path, 'utf8');

describe('Aegis stage 8 privacy boundaries', () => {
  it('builds push notifications from a fixed content-blind template', () => {
    const payload = buildPrivacySafePushPayload({
      kind: 'message',
      title: 'secret title',
      body: 'private plaintext',
      url: 'https://attacker.invalid/private',
    } as never);
    expect(payload).toMatchObject({
      title: 'Nouveau message',
      body: 'Ouvrez ForSure pour le consulter.',
      url: '/messages',
      kind: 'message',
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('secret title');
    expect(serialized).not.toContain('private plaintext');
    expect(serialized).not.toContain('attacker.invalid');
  });

  it('never exposes raw exception text through server diagnostics', () => {
    const error = Object.assign(new Error('plaintext=top-secret'), {
      code: 'DB_TIMEOUT',
      status: 503,
    });
    const metadata = safeServerErrorMeta(error);
    expect(metadata).toEqual({
      error_name: 'Error',
      error_code: 'DB_TIMEOUT',
      status_code: 503,
    });
    expect(JSON.stringify(metadata)).not.toContain('top-secret');
    expect(sanitizeServerLogMetadata({ body: 'secret', status: 'failed', sent: 1 }))
      .toEqual({ status: 'failed', sent: 1 });
  });

  it('enforces redaction in persistent crypto diagnostics', () => {
    const source = read('src/lib/crypto/errorLogger.ts');
    expect(source).toContain('sanitizeCryptoMetadata');
    expect(source).toContain('conversation_id: null');
    expect(source).toContain('my_device_id: null');
    expect(source).toContain('peer_user_id: null');
    expect(source).toContain('peer_device_id: null');
    expect(source).toContain('stack: null');
    expect(source).toContain('user_agent: null');
    expect(source).toContain('CRYPTO_DIAGNOSTIC_');
    expect(source).not.toContain('err.stack?.slice');
    expect(source).not.toContain('navigator.userAgent');
  });

  it('drops identifiers from in-memory E2EE traces', () => {
    const source = read('src/lib/messaging/e2eeTrace.ts');
    expect(source).toContain('sanitizeE2EETraceEvent');
    expect(source).toContain('Identifiers supplied by callers are deliberately dropped');
    expect(source).not.toContain('const record: E2EETraceEvent = { at: new Date().toISOString(), ...event }');
  });

  it('removes server-readable message moderation and unsafe logs', () => {
    const moderation = read('supabase/functions/message-moderation/index.ts');
    expect(moderation).toContain('E2EE_MESSAGE_CONTENT_UNAVAILABLE');
    expect(moderation).not.toContain('messageBody');
    expect(moderation).not.toContain('sanitizeForAI');
    expect(moderation).not.toContain('ai.gateway');

    const push = read('supabase/functions/push-notify/index.ts');
    expect(push).toContain('buildPrivacySafePushPayload');
    expect(push).toContain('.select("id,endpoint,p256dh,auth")');
    expect(push).not.toContain('body: msgBody');
    expect(push).not.toContain('res.text()');

    expect(read('src/hooks/useAegisMessageQueue.ts')).not.toContain("console.info('[MSG_TRACE]'");
    expect(read('src/lib/crypto/x3dh.ts')).not.toContain('UPSERT_PAYLOAD');
    expect(read('src/lib/messaging/realtimeKeySync.ts')).not.toContain('UPSERT_PAYLOAD');
    expect(read('supabase/functions/sealed-relay/index.ts')).not.toContain('console.error("[sealed-relay]');
    expect(read('supabase/functions/sealed-mint-token/index.ts')).not.toContain('console.error("[sealed-mint]');
    expect(read('supabase/functions/livekit-token/index.ts')).not.toContain('LiveKit token error:');
  });
});
