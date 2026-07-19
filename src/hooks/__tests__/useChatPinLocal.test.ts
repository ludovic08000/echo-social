import { beforeEach, describe, expect, it } from 'vitest';
import { __test__ } from '@/hooks/useChatPin';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('local-only messaging PIN', () => {
  beforeEach(async () => {
    await __test__.removeLocalPin(USER_ID).catch(() => undefined);
  });

  it('verifies locally and rejects an incorrect PIN', async () => {
    await __test__.saveLocalPin(USER_ID, '123456');

    await expect(__test__.verifyLocalPin(USER_ID, '123456')).resolves.toBe(true);
    await expect(__test__.verifyLocalPin(USER_ID, '654321')).resolves.toBe(false);
  });

  it('stores only an encrypted verifier and never the PIN', async () => {
    await __test__.saveLocalPin(USER_ID, '123456');
    const record = await __test__.loadLocalPin(USER_ID);

    expect(record?.version).toBe(2);
    expect(JSON.stringify(record)).not.toContain('123456');
    expect(record?.wrappedBlob).toBeTruthy();
  });
});
