// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const companion = readFileSync('src/components/ZeusCompanion.tsx', 'utf8');
const hud = readFileSync('src/components/voice/ForSureVoiceHud.tsx', 'utf8');
const proactive = readFileSync('src/hooks/useZeusProactiveAssistant.ts', 'utf8');

describe('local Zeus voice architecture', () => {
  it('does not depend on the missing external voice deployment', () => {
    expect(companion).not.toContain('functions/v1/voice-session');
    expect(companion).not.toContain("window.open('about:blank'");
    expect(companion).not.toContain('voice.forsure.fans');
  });

  it('keeps the microphone gesture-driven and command reviewable before processing', () => {
    expect(hud).toContain('onClick={startListening}');
    expect(hud).toContain('onSubmitCommand(text)');
    expect(hud).toContain('Confirmation requise');
    expect(hud).toContain('Aucune publication, aucun message et aucun réglage ne seront exécutés sans votre confirmation.');
  });

  it('routes a voice command through the existing Zeus action confirmation path', () => {
    expect(companion).toContain('sendMessage(command, { fromVoice: true })');
    expect(companion).toContain('onSubmitCommand={submitVoiceCommand}');
    expect(companion).toContain('confirmez toute action à l’écran');
  });

  it('uses the user-selected assistant name for the connection briefing', () => {
    expect(proactive).toContain('useZeusSettings');
    expect(proactive).toContain('readyAnnouncement(zeusName)');
    expect(proactive).toContain('toast.info(zeusName');
  });
});
