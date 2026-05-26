import { describe, expect, it } from 'vitest';
import { wrapPlaintextForDevice } from '../deviceWrap';

describe('deviceWrap invalid-device guard', () => {
  it('refuses to encrypt a legacy fallback copy for a known invalid device', async () => {
    await expect(
      wrapPlaintextForDevice(
        'hello',
        'sender-user',
        'recipient-device-public-key',
        '84aaa52143235807214bf3aa161dd03a',
      ),
    ).rejects.toThrow('DEVICE_CRYPTO_INVALID');
  });
});
