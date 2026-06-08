import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';
import { isMultiDeviceEnvelopeBody } from '@/lib/messaging/messageCompatibility';
import { buildMultiDeviceParentEnvelope, shouldArchiveMessageBody, waitForArchiveInline } from '../useMessageQueue';

const MEDIA_KEY =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('useMessageQueue archive gating', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('archives normal encrypted text bodies', () => {
    expect(
      shouldArchiveMessageBody({
        sanitized: 'hello',
        isSpecial: false,
        encryptedSuccessfully: true,
        encryptionWasRequired: true,
      }),
    ).toBe(true);
  });

  it('archives encrypted media bodies that carry a media key', () => {
    expect(
      shouldArchiveMessageBody({
        sanitized: buildMediaMessageBody('Photo', MEDIA_KEY),
        isSpecial: true,
        encryptedSuccessfully: true,
        encryptionWasRequired: true,
      }),
    ).toBe(true);
  });

  it('does not archive view-once media keys', () => {
    expect(
      shouldArchiveMessageBody({
        sanitized: buildMediaMessageBody('Photo', MEDIA_KEY),
        isSpecial: true,
        viewOnce: true,
        encryptedSuccessfully: true,
        encryptionWasRequired: true,
      }),
    ).toBe(false);
  });

  it('does not archive legacy special labels without a media key', () => {
    expect(
      shouldArchiveMessageBody({
        sanitized: 'Photo',
        isSpecial: true,
        encryptedSuccessfully: true,
        encryptionWasRequired: true,
      }),
    ).toBe(false);
  });

  it('does not archive when encryption was not used or required', () => {
    expect(
      shouldArchiveMessageBody({
        sanitized: buildMediaMessageBody('Photo', MEDIA_KEY),
        isSpecial: true,
        encryptedSuccessfully: false,
        encryptionWasRequired: false,
      }),
    ).toBe(false);
  });

  it('keeps fast archive payloads inline', async () => {
    await expect(waitForArchiveInline(Promise.resolve('archive-payload'), 25))
      .resolves.toBe('archive-payload');
  });

  it('does not block send while a slow archive payload is still encrypting', async () => {
    vi.useFakeTimers();
    const slowArchive = new Promise<string>((resolve) => {
      setTimeout(() => resolve('late-archive-payload'), 1000);
    });
    const inline = waitForArchiveInline(slowArchive, 25);

    await vi.advanceTimersByTimeAsync(25);
    await expect(inline).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    await expect(slowArchive).resolves.toBe('late-archive-payload');
  });

  it('builds a valid encrypted-only multi-device parent envelope', () => {
    const envelope = buildMultiDeviceParentEnvelope('local-1', 'trace-1');
    const parsed = JSON.parse(envelope);

    expect(isMultiDeviceEnvelopeBody(envelope)).toBe(true);
    expect(parsed).toMatchObject({
      encryptionMode: 'multi_device',
      v: PROTOCOL_VERSION,
      ct: 'device_copies',
      __lid: 'local-1',
      __tid: 'trace-1',
    });
    expect(envelope).not.toContain('hello');
  });
});
