import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAegisMessage,
  openAegisMessage,
  parseAegisKeyCapsule,
} from '@/lib/messaging/aegisEnvelope';
import {
  clearE2EETrace,
  readE2EETrace,
  traceE2EE,
  traceE2EEBlock,
} from '@/lib/messaging/e2eeTrace';

const ids = {
  messageId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
  senderId: '33333333-3333-4333-8333-333333333333',
};

interface StoredMessage {
  body: string;
  keyCapsule: string;
}

describe('Aegis traced send -> server -> receive -> decrypt integration', () => {
  beforeEach(() => {
    clearE2EETrace();
  });

  it('correlates one message end-to-end without leaking plaintext, keys, or raw identifiers', async () => {
    const plaintext = 'integration secret that must never reach trace logs';
    const traceId = 'trace-send-receive-integration';

    traceE2EE({
      direction: 'send',
      component: 'integration_sender',
      stage: 'SEND_CREATED',
      outcome: 'start',
      traceId,
      messageId: ids.messageId,
      conversationId: ids.conversationId,
    });

    const created = await traceE2EEBlock({
      direction: 'send',
      component: 'integration_sender',
      stage: 'PARENT_ENCRYPT',
      traceId,
      messageId: ids.messageId,
      conversationId: ids.conversationId,
    }, () => createAegisMessage({
      ...ids,
      plaintext,
      traceId,
      localId: 'local-integration-message',
    }));

    const server = new Map<string, StoredMessage>();
    traceE2EE({
      direction: 'send',
      component: 'integration_transport',
      stage: 'SERVER_SEND',
      outcome: 'start',
      traceId,
      messageId: ids.messageId,
      conversationId: ids.conversationId,
      transport: 'aegis_server',
      payloadBytes: new TextEncoder().encode(created.body).byteLength,
    });
    server.set(ids.messageId, {
      body: created.body,
      keyCapsule: created.keyCapsule,
    });
    traceE2EE({
      direction: 'send',
      component: 'integration_transport',
      stage: 'MESSAGE_COMMITTED',
      outcome: 'ok',
      traceId,
      messageId: ids.messageId,
      conversationId: ids.conversationId,
      transport: 'aegis_server',
      copyCount: 1,
    });

    const delivered = server.get(ids.messageId);
    expect(delivered).toBeDefined();

    traceE2EE({
      direction: 'receive',
      component: 'integration_inbox',
      stage: 'SERVER_INBOX_DELIVERY',
      outcome: 'ok',
      traceId,
      messageId: ids.messageId,
      conversationId: ids.conversationId,
      transport: 'aegis_server',
    });
    traceE2EE({
      direction: 'receive',
      component: 'integration_inbox',
      stage: 'DEVICE_COPY_LOOKUP',
      outcome: 'ok',
      traceId,
      messageId: ids.messageId,
      conversationId: ids.conversationId,
      cache: 'network',
    });

    const decrypted = await traceE2EEBlock({
      direction: 'receive',
      component: 'integration_decryptor',
      stage: 'CONTENT_AES_DECRYPT',
      traceId,
      messageId: ids.messageId,
      conversationId: ids.conversationId,
    }, () => openAegisMessage(
      delivered!.body,
      delivered!.keyCapsule,
      ids,
    ));

    expect(decrypted).toBe(plaintext);
    traceE2EE({
      direction: 'receive',
      component: 'integration_decryptor',
      stage: 'PLAINTEXT_RESOLVE',
      outcome: 'ok',
      traceId,
      messageId: ids.messageId,
      conversationId: ids.conversationId,
    });

    const events = readE2EETrace();
    const stages = events.map((event) => `${event.direction}:${event.stage}:${event.outcome ?? ''}`);

    expect(stages).toEqual([
      'send:SEND_CREATED:start',
      'send:PARENT_ENCRYPT:start',
      'send:PARENT_ENCRYPT:ok',
      'send:SERVER_SEND:start',
      'send:MESSAGE_COMMITTED:ok',
      'receive:SERVER_INBOX_DELIVERY:ok',
      'receive:DEVICE_COPY_LOOKUP:ok',
      'receive:CONTENT_AES_DECRYPT:start',
      'receive:CONTENT_AES_DECRYPT:ok',
      'receive:PLAINTEXT_RESOLVE:ok',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const messageRefs = new Set(events.map((event) => event.messageRef));
    const conversationRefs = new Set(events.map((event) => event.conversationRef));
    const traceRefs = new Set(events.map((event) => event.traceRef));
    expect(messageRefs).toEqual(new Set(['msg-001']));
    expect(conversationRefs).toEqual(new Set(['conv-001']));
    expect(traceRefs).toEqual(new Set(['trace-001']));

    const serializedTrace = JSON.stringify(events);
    const contentKey = parseAegisKeyCapsule(created.keyCapsule)?.contentKey;
    expect(contentKey).toBeTruthy();
    expect(serializedTrace).not.toContain(plaintext);
    expect(serializedTrace).not.toContain(ids.messageId);
    expect(serializedTrace).not.toContain(ids.conversationId);
    expect(serializedTrace).not.toContain(ids.senderId);
    expect(serializedTrace).not.toContain(created.body);
    expect(serializedTrace).not.toContain(created.keyCapsule);
    expect(serializedTrace).not.toContain(contentKey!);
  });
});
