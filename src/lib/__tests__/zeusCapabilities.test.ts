import { afterEach,describe, expect, it,vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { capabilityForCommand, ZEUS_CAPABILITIES, ZEUS_CAPABILITY_IDS,zeusCommandFingerprint } from '@/lib/zeusCapabilities';
import { zeusCommandSchema } from '@/lib/zeusCommands';
afterEach(()=>vi.unstubAllGlobals());

describe('Zeus capability registry', () => {
  it('never fingerprints private message text into a server-observable dictionary hash',async()=>{
    vi.stubGlobal('crypto',webcrypto);
    const first=await zeusCommandFingerprint({type:'send_message',message_text:'Un texte privé'},'peer');
    expect(await zeusCommandFingerprint({type:'send_message',message_text:'Un autre texte'},'peer')).toBe(first);
    expect(await zeusCommandFingerprint({type:'send_message',message_text:'Un texte privé'},'other')).not.toBe(first);
  });
  it('computes the same publication fingerprint irrespective of object key order',async()=>{
    vi.stubGlobal('crypto',webcrypto);
    expect(await zeusCommandFingerprint({type:'publish_post',body:'Texte'})).toBe(await zeusCommandFingerprint({body:'Texte',type:'publish_post'}));
  });
  it('keeps every capability explicitly scoped to the signed-in user', () => {
    expect(Object.keys(ZEUS_CAPABILITIES).sort()).toEqual([...ZEUS_CAPABILITY_IDS].sort());
    expect(Object.values(ZEUS_CAPABILITIES).every(capability => capability.userScoped)).toBe(true);
  });

  it.each(['send_message', 'start_call', 'publish_post', 'respond_friend_request'] as const)(
    'requires confirmation for %s',
    type => expect(capabilityForCommand(type).requiresConfirmation).toBe(true),
  );

  it('allows reading activity and opening a requested profile without a mutation confirmation', () => {
    expect(capabilityForCommand('read_activity').risk).toBe('read');
    expect(capabilityForCommand('show_friend_request_profile').risk).toBe('navigate');
    expect(capabilityForCommand('show_friend_request_profile').requiresConfirmation).toBe(false);
  });

  it('accepts only whitelisted appearance values', () => {
    expect(zeusCommandSchema.safeParse({
      type: 'update_feed_appearance',
      font_family: 'georgia',
      background_color: '#0d0d1a',
    }).success).toBe(true);
    expect(zeusCommandSchema.safeParse({
      type: 'update_feed_appearance',
      background_color: 'url(javascript:alert(1))',
    }).success).toBe(false);
    expect(zeusCommandSchema.safeParse({ type: 'update_feed_appearance' }).success).toBe(false);
  });

  it('accepts a person name from the model and rejects an empty target', () => {
    expect(zeusCommandSchema.safeParse({
      type: 'respond_friend_request',
      requester_name: '',
      decision: 'accept',
    }).success).toBe(false);
  });
});
