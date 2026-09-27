import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('call hardening isolation and rollback', () => {
  it('keeps the call kill switch out of every authoritative message path', () => {
    for (const path of [
      'src/lib/messaging/aegisOutboundEngine.ts',
      'src/hooks/useAegisMessageQueue.ts',
      'src/lib/messaging/aegisTransport.ts',
    ]) {
      const source = read(path);
      expect(source).not.toMatch(/VITE_AEGIS_CALLS_ENABLED|lib\/calls|from ['"]@\/hooks\/useCall|livekit/i);
    }
    const policy = read('src/lib/calls/callPolicy.ts');
    expect(policy).toContain('VITE_AEGIS_CALLS_ENABLED');
    expect(policy).not.toMatch(/from ['"].*(messaging|outbound|transport)/i);
  });

  it('fails closed instead of falling back to an unencrypted call', () => {
    const call = read('src/hooks/useCall.ts');
    expect(call).toContain('isE2EESupported()');
    expect(call).toContain("CALL_E2EE_UNSUPPORTED");
    expect(call).toContain('await room.setE2EEEnabled(true)');
    expect(call).not.toMatch(/disableE2EE|unencryptedCall|e2ee:\s*false/i);
  });

  it('issues short-lived call tokens only after device and invitation checks', () => {
    const edge = read('supabase/functions/livekit-token/index.ts');
    expect(edge).toContain('ttl: "10m"');
    expect(edge).toContain('CALL_DEVICE_NOT_AUTHORIZED');
    expect(edge).toContain('CALL_DEVICE_NOT_INVITED');
    expect(edge).toContain('x-aegis-diagnostic-id');
    expect(edge.indexOf('diagnostic.step("device_authorization")'))
      .toBeLessThan(edge.indexOf('const accessToken = new AccessToken'));
    expect(edge.indexOf('diagnostic.step("invitation_authorization")'))
      .toBeLessThan(edge.indexOf('const accessToken = new AccessToken'));
    expect(edge).not.toContain('LIVEKIT_API_SECRET)!');
  });

  it('scopes cached LiveKit tokens to the authenticated account', () => {
    const client = read('src/lib/livekit.ts');
    expect(client).toContain('cacheKey(roomName, userId, deviceId)');
    expect(client).toContain('session.user.id !== expectedUserId');
    expect(client).not.toContain('cacheKey(roomName, deviceId)');
  });
});
