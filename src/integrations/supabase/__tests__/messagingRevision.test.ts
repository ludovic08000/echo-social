// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { withMessagingRevision } from '../messagingRevision';
const backend = 'https://cloud.test';
describe('messaging API revision transport', () => {
  it('preserves authentication, body and cancellation', () => {
    const controller = new AbortController();
    const init = { method:'POST',headers:{ authorization:'Bearer test',apikey:'publishable' },body:'{}',signal:controller.signal };
    const result = withMessagingRevision(`${backend}/rest/v1/rpc/publish_libsignal_prekey_bundle`, init, backend)!;
    expect(result.body).toBe(init.body);
    expect(result.signal).toBe(init.signal);
    expect(new Headers(result.headers).get('authorization')).toBe('Bearer test');
    expect(new Headers(result.headers).get('x-forsure-messaging-revision')).toBe('1');
    expect(init.headers).not.toHaveProperty('x-forsure-messaging-revision');
  });
  it('preserves headers supplied by a Request object', () => {
    const req = new Request(`${backend}/rest/v1/messages`,{ headers:{ authorization:'Bearer request' } });
    expect(new Headers(withMessagingRevision(req,undefined,backend)?.headers).get('authorization')).toBe('Bearer request');
  });
  it.each(['/auth/v1/token','/functions/v1/livekit-token','/storage/v1/object'])('does not modify other APIs %s', (path) => {
    expect(withMessagingRevision(`${backend}${path}`,undefined,backend)).toBeUndefined();
  });
  it('does not add headers to third-party requests', () => {
    expect(withMessagingRevision('https://unrelated.test/rest/v1/messages',undefined,backend)).toBeUndefined();
  });
});
