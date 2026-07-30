import fs from 'node:fs';

function edit(path, transform) {
  const before = fs.readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No change applied to ${path}`);
  fs.writeFileSync(path, after);
}

function replaceOne(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`Ambiguous patch anchor: ${label}`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

edit('src/hooks/useAegisMessageQueue.ts', (source) => {
  source = replaceOne(source,
`import { runAegisOutboxJob } from '@/lib/messaging/aegisConversationQueue';
`,
`import { runAegisOutboxJob } from '@/lib/messaging/aegisConversationQueue';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';
`,
'queue trace import');
  source = replaceOne(source,
`    const trace = (stage: string, traceExtra: Record<string, unknown> = {}) => {
      const elapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - traceStartedAt);
      console.info('[MSG_TRACE]', {
        stage,
        elapsedMs,
        localId,
        traceId,
        conversationId,
        userId: user.id,
        encryptionWasRequested: !allowPlaintext,
        isEncryptionReady,
        hasMedia: !!imageUrl,
        resumed: Boolean(resumePayload),
        ...traceExtra,
      });
    };
`,
`    const trace = (stage: string, traceExtra: Record<string, unknown> = {}) => {
      const elapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - traceStartedAt);
      traceE2EE({
        direction: 'send',
        stage,
        elapsedMs,
        targetCount: typeof traceExtra.targetCount === 'number' ? traceExtra.targetCount : undefined,
        copyCount: typeof traceExtra.copyCount === 'number' ? traceExtra.copyCount : undefined,
        retryCount: typeof traceExtra.retryCount === 'number' ? traceExtra.retryCount : undefined,
        errorCode: typeof traceExtra.errorCode === 'string' ? traceExtra.errorCode : undefined,
      });
    };
`,
'queue content-blind trace');
  return source;
});

edit('supabase/functions/sealed-relay/index.ts', (source) => {
  source = replaceOne(source,
`import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
`,
`import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { safeServerErrorMeta, safeServerLog } from "../_shared/aegis-privacy.ts";
`,
'sealed relay privacy import');
  source = replaceOne(source,
`      console.error("[sealed-relay] insert failed", insErr);
`,
`      safeServerLog("sealed-relay", "STORE_FAILED", safeServerErrorMeta(insErr));
`,
'sealed relay insert log');
  source = replaceOne(source,
`  } catch (e) {
    console.error("[sealed-relay] error", e);
`,
`  } catch (e) {
    safeServerLog("sealed-relay", "UNHANDLED", safeServerErrorMeta(e));
`,
'sealed relay catch log');
  return source;
});

edit('supabase/functions/sealed-mint-token/index.ts', (source) => {
  source = replaceOne(source,
`import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
`,
`import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { safeServerErrorMeta, safeServerLog } from "../_shared/aegis-privacy.ts";
`,
'sealed mint privacy import');
  source = replaceOne(source,
`      console.error("[sealed-mint] insert failed", insErr);
`,
`      safeServerLog("sealed-mint", "STORE_FAILED", safeServerErrorMeta(insErr));
`,
'sealed mint insert log');
  source = replaceOne(source,
`  } catch (e) {
    console.error("[sealed-mint] error", e);
`,
`  } catch (e) {
    safeServerLog("sealed-mint", "UNHANDLED", safeServerErrorMeta(e));
`,
'sealed mint catch log');
  return source;
});

edit('supabase/functions/livekit-token/index.ts', (source) => {
  source = replaceOne(source,
`import { checkRateLimit as checkRateLimitDB } from "../_shared/rate-limit.ts";
`,
`import { checkRateLimit as checkRateLimitDB } from "../_shared/rate-limit.ts";
import { safeServerErrorMeta, safeServerLog } from "../_shared/aegis-privacy.ts";
`,
'livekit privacy import');
  source = replaceOne(source,
`  } catch (error) {
    console.error("LiveKit token error:", error);
`,
`  } catch (error) {
    safeServerLog("livekit-token", "UNHANDLED", safeServerErrorMeta(error));
`,
'livekit catch log');
  return source;
});

edit('src/lib/crypto/x3dh.ts', (source) => {
  source = replaceOne(source,
`function logDBPayloadBeforeUpsert(table: 'device_signed_prekeys', payload: Record<string, unknown>) {
  console.log('[X3DH][DB][UPSERT_PAYLOAD]', {
    table,
    payload_keys: Object.keys(payload),
    fields: sanitizeDBPayload(payload),
  });
}
`,
`function logDBPayloadBeforeUpsert(table: 'device_signed_prekeys', payload: Record<string, unknown>) {
  console.info('[X3DH][DB][UPSERT]', { table, field_count: Object.keys(payload).length });
}
`,
'x3dh payload log');
  source = replaceOne(source,
`  const diagnostic = {
    table,
    step,
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
    constraint_violated: violatedConstraint ?? 'unknown_from_supabase_error',
    rejected_column: rejectedColumn ?? 'unknown_from_supabase_error',
    rejected_value: rejectedColumn ? describeDBValue(rejectedColumn, payload[rejectedColumn]) : undefined,
    payload_keys: Object.keys(payload),
    payload: sanitizeDBPayload(payload),
  };
  console.error('[X3DH][DB][UPSERT_FAIL]', diagnostic);
  return diagnostic;
`,
`  const diagnostic = {
    table,
    step,
    code: error?.code ?? 'DB_ERROR',
    constraint_violated: violatedConstraint ?? 'unknown',
    rejected_column: rejectedColumn ?? 'unknown',
    field_count: Object.keys(payload).length,
  };
  console.error('[X3DH][DB][UPSERT_FAIL]', diagnostic);
  return diagnostic;
`,
'x3dh failure redaction');
  return source;
});

edit('src/lib/crypto/resyncE2EE.ts', (source) => {
  source = replaceOne(source,
`function logPayloadBeforeUpsert(table: DBTableName, payload: DBPayload) {
  console.log('[E2EE][DB][UPSERT_PAYLOAD]', {
    table,
    payload_keys: Object.keys(payload),
    fields: sanitizePayloadForLog(payload),
  });
}
`,
`function logPayloadBeforeUpsert(table: DBTableName, payload: DBPayload) {
  console.info('[E2EE][DB][UPSERT]', { table, field_count: Object.keys(payload).length });
}
`,
'resync payload log');
  source = replaceOne(source,
`  console.log('[resync] user_devices.upsert payload', {
    user_id: payload.user_id,
    device_id: payload.device_id,
    device_id_len: payload.device_id.length,
    platform: payload.platform,
    device_name: payload.device_name,
    device_public_key_type: typeof payload.device_public_key,
    device_public_key_len: payload.device_public_key.length,
    user_agent_len: payload.user_agent?.length ?? 0,
  });
`,
`  console.info('[resync] user device registration prepared', {
    device_id_len: payload.device_id.length,
    device_public_key_len: payload.device_public_key.length,
    user_agent_len: payload.user_agent?.length ?? 0,
  });
`,
'resync device log');
  return source;
});

edit('src/components/messages/decryptionService.ts', (source) => replaceOne(source,
`      if (typeof console !== 'undefined') {
        trace('DEVICE_COPY_UNAVAILABLE', {
          conversationId: aegisEnvelope.conversationId,
        }, 'warn');
        console.warn('[DECRYPT-FAIL] Aegis device key capsule unavailable', {
          messageId,
          kind: 'aegis-v1',
          isMe: opts.isMe === true,
          senderId: senderId ? String(senderId).slice(0, 8) : null,
          stickyAvailable: Boolean(readLastGoodOutcome(messageId, body)),
        });
      }
`,
`      trace('DEVICE_COPY_UNAVAILABLE', {}, 'warn');
`,
'decryption failure metadata'));

edit('src/hooks/useMessages.ts', (source) => {
  source = source.replace(
    `console.warn('[messaging] failed to repair hidden conversation messages:', error.message);`,
    `console.warn('[messaging] hidden-message repair failed', { code: error.code ?? 'DB_ERROR' });`,
  );
  source = source.replace(
`  console.warn('[messaging] restored hidden messages after session return', {
    conversationId,
    count: ids.length,
  });`,
`  console.warn('[messaging] restored hidden messages after session return', { count: ids.length });`,
  );
  source = source.replace(
    `console.log('[messaging] fetching conversations for', user.id);`,
    `console.info('[messaging] fetching conversations');`,
  );
  source = source.replace(
    `console.warn('[messaging] ignoring unsupported encrypted message without hiding it', newMsg.id);`,
    `console.warn('[messaging] ignoring unsupported encrypted message without hiding it');`,
  );
  source = source.replace(
    `console.log('[messaging] fetching messages for conversation', conversationId);`,
    `console.info('[messaging] fetching messages');`,
  );
  source = source.replace(
    `console.error('[messaging] message fetch failed:', error.message);`,
    `console.error('[messaging] message fetch failed', { code: error.code ?? 'DB_ERROR' });`,
  );
  return source;
});

const testPath = 'src/lib/messaging/__tests__/aegisStage8PrivacyBoundaries.test.ts';
fs.writeFileSync(testPath, `import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPrivacySafePushPayload,
  safeServerErrorMeta,
  sanitizeServerLogMetadata,
} from '../../../../supabase/functions/_shared/aegis-privacy';
import {
  classifyCryptoError,
  sanitizeCryptoMetadata,
} from '@/lib/crypto/errorLogger';
import { sanitizeE2EETraceEvent } from '@/lib/messaging/e2eeTrace';

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
    expect(JSON.stringify(payload)).not.toContain('secret');
    expect(JSON.stringify(payload)).not.toContain('private plaintext');
    expect(JSON.stringify(payload)).not.toContain('attacker.invalid');
  });

  it('never exposes raw exception text through server diagnostics', () => {
    const error = Object.assign(new Error('plaintext=top-secret'), { code: 'DB_TIMEOUT', status: 503 });
    const meta = safeServerErrorMeta(error);
    expect(meta).toEqual({ error_name: 'Error', error_code: 'DB_TIMEOUT', status_code: 503 });
    expect(JSON.stringify(meta)).not.toContain('top-secret');
    expect(sanitizeServerLogMetadata({ body: 'secret', status: 'failed', sent: 1 }))
      .toEqual({ status: 'failed', sent: 1 });
  });

  it('redacts crypto identifiers, stacks and arbitrary metadata', () => {
    expect(sanitizeCryptoMetadata({
      stage: 'fanout',
      copyCount: 3,
      plaintext: 'secret',
      messageId: 'uuid',
      token: 'token',
      retryCount: 2,
    })).toEqual({ stage: 'fanout', copyCount: 3, retryCount: 2 });
    const classified = classifyCryptoError(new Error('decrypt failed for plaintext=secret'));
    expect(classified.code).toBe('E_DECRYPT');
    expect(classified.message).toBe('CRYPTO_DIAGNOSTIC_E_DECRYPT');
    expect(JSON.stringify(classified)).not.toContain('secret');
  });

  it('drops all message, conversation, device and session identifiers from traces', () => {
    const sanitized = sanitizeE2EETraceEvent({
      direction: 'send',
      stage: 'MESSAGE_COMMITTED',
      messageId: 'message-secret',
      conversationId: 'conversation-secret',
      deviceId: 'device-secret',
      sessionId: 'session-secret',
      copyCount: 2,
    });
    expect(sanitized).toEqual({ direction: 'send', stage: 'MESSAGE_COMMITTED', copyCount: 2 });
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
    expect(read('src/lib/crypto/resyncE2EE.ts')).not.toContain('UPSERT_PAYLOAD');
    expect(read('supabase/functions/sealed-relay/index.ts')).not.toContain('console.error("[sealed-relay]');
    expect(read('supabase/functions/sealed-mint-token/index.ts')).not.toContain('console.error("[sealed-mint]');
    expect(read('supabase/functions/livekit-token/index.ts')).not.toContain('LiveKit token error:');
  });
});
`);

edit('docs/AEGIS_CLEAN_REBUILD.md', (source) => {
  source = replaceOne(source,
`8. Privacy boundaries for logs, push notifications and server functions.
`,
`8. ✅ Privacy boundaries for logs, push notifications and server functions.
`,
'stage 8 checklist');
  source = replaceOne(source,
`## Current checkpoint
`,
`## Stage 8 invariant

Push notifications are content-blind: clients select a bounded event kind and the server constructs a fixed generic title, body, route and tag. Peer-message plaintext is never accepted by moderation, AI, logging or notification functions. Persistent crypto diagnostics contain only bounded error codes, stages, booleans and counters; raw exceptions, stacks, UUIDs, user agents, URLs, ciphertext, keys and arbitrary metadata are discarded. In-memory E2EE traces apply the same identifier-free contract. Messaging, Sealed Sender and call functions log only stable diagnostic codes and numeric status metadata.

## Current checkpoint
`,
'stage 8 invariant');
  source = source.replace(
    '- Stages 1, 2, 3, 4, 5, 6 and 7 are complete and validated.',
    '- Stages 1, 2, 3, 4, 5, 6, 7 and 8 are complete and validated.',
  );
  source = source.replace(
    '- Stage 7 passed its exact claim/commit receipt tests, UUID and metadata binding tests, architecture checks, typecheck, the full test suite and the production build.',
    '- Stage 8 passed its generic-push, server-error redaction, crypto-log redaction, identifier-free trace and architecture tests, typecheck, the full test suite and the production build.',
  );
  return source;
});
