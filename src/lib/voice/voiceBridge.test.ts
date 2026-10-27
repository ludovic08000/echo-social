import { describe, expect, it } from 'vitest';
import {
  createVoiceLaunchUrl,
  parseVoiceProposalEvent,
  voiceProposalToZeusContent,
} from './voiceBridge';

describe('voiceBridge', () => {
  it('keeps the one-time ticket out of the request URL', () => {
    const launch = new URL(createVoiceLaunchUrl('https://voice.forsure.fans', 'secret-ticket', 'n'.repeat(32)));
    expect(launch.search).toBe('');
    expect(launch.hash).toContain('ticket=secret-ticket');
  });

  it('accepts only the expected origin, popup and nonce', () => {
    const popup = {} as Window;
    const data = {
      type: 'forsure.voice.proposal',
      nonce: 'n'.repeat(32),
      proposal: { type: 'publish_post', body: 'Bonjour' },
    };
    expect(parseVoiceProposalEvent(
      { origin: 'https://voice.forsure.fans', source: popup, data },
      { origin: 'https://voice.forsure.fans', source: popup, nonce: 'n'.repeat(32) },
    )).toEqual(data.proposal);
    expect(parseVoiceProposalEvent(
      { origin: 'https://evil.example', source: popup, data },
      { origin: 'https://voice.forsure.fans', source: popup, nonce: 'n'.repeat(32) },
    )).toBeNull();
    expect(parseVoiceProposalEvent(
      { origin: 'https://voice.forsure.fans', source: {} as Window, data },
      { origin: 'https://voice.forsure.fans', source: popup, nonce: 'n'.repeat(32) },
    )).toBeNull();
  });

  it('rejects actions outside the strict allowlist', () => {
    const popup = {} as Window;
    const proposal = parseVoiceProposalEvent({
      origin: 'https://voice.forsure.fans',
      source: popup,
      data: { type: 'forsure.voice.proposal', nonce: 'n'.repeat(32), proposal: { type: 'delete_account' } },
    }, { origin: 'https://voice.forsure.fans', source: popup, nonce: 'n'.repeat(32) });
    expect(proposal).toBeNull();
  });

  it('never accepts a message when the expected popup is missing', () => {
    expect(parseVoiceProposalEvent({
      origin: 'https://voice.forsure.fans',
      source: null,
      data: {
        type: 'forsure.voice.proposal', nonce: 'n'.repeat(32),
        proposal: { type: 'publish_post', body: 'Bonjour' },
      },
    }, { origin: 'https://voice.forsure.fans', source: null, nonce: 'n'.repeat(32) })).toBeNull();
  });

  it('creates a Zeus confirmation card instead of executing directly', () => {
    const content = voiceProposalToZeusContent({ type: 'send_message', conversation_id: crypto.randomUUID(), message_text: 'Salut' });
    expect(content).toContain('Vérifiez puis confirmez');
    expect(content).toContain('```forsure-action');
  });

  it('allows a recipient name for main-app disambiguation but refuses no recipient', () => {
    const popup = {} as Window;
    const common = { origin: 'https://voice.forsure.fans', source: popup };
    const expected = { origin: common.origin, source: popup, nonce: 'n'.repeat(32) };
    expect(parseVoiceProposalEvent({ ...common, data: {
      type: 'forsure.voice.proposal', nonce: 'n'.repeat(32),
      proposal: { type: 'send_message', recipient_name: 'Nadège Dupont', message_text: 'Bonjour' },
    } }, expected)?.type).toBe('send_message');
    expect(parseVoiceProposalEvent({ ...common, data: {
      type: 'forsure.voice.proposal', nonce: 'n'.repeat(32),
      proposal: { type: 'send_message', message_text: 'Bonjour' },
    } }, expected)).toBeNull();
  });
});
