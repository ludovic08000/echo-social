import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const zeus = readFileSync('supabase/functions/zeus/index.ts', 'utf8');
const aiContent = readFileSync('supabase/functions/ai-content/index.ts', 'utf8');
const chat = readFileSync('src/components/ChatWidget.tsx', 'utf8');
const negotiation = readFileSync('src/components/marketplace/NegotiationChat.tsx', 'utf8');

describe('chat AI assistance', () => {
  it('uses the current Lovable lightweight text model', () => {
    const contentHandler = zeus.slice(
      zeus.indexOf('async function handleContent'),
      zeus.indexOf('// ── POST ASSISTANT'),
    );
    expect(contentHandler).toContain('CONTENT_AI_MODEL');
    expect(zeus).toContain('const CONTENT_AI_MODEL = "google/gemini-3.1-flash-lite";');
    expect(contentHandler).not.toContain('google/gemini-3-flash-preview');
    expect(aiContent).toContain('const model = "google/gemini-3.1-flash-lite";');
  });

  it('logs gateway failures without logging the user text', () => {
    const contentHandler = zeus.slice(
      zeus.indexOf('async function handleContent'),
      zeus.indexOf('// ── POST ASSISTANT'),
    );
    expect(contentHandler).toContain('[zeus.content] AI gateway fetch failed');
    expect(contentHandler).toContain('[zeus.content] AI gateway rejected request');
    expect(contentHandler).not.toMatch(/console\.(?:error|warn)\([^\n]*text/);
  });

  it('shows the server error in both chat composers', () => {
    for (const source of [chat, negotiation]) {
      expect(source).toContain("import { edgeFunctionErrorMessage } from '@/lib/edgeFunctionError';");
      expect(source).toContain('await edgeFunctionErrorMessage(error)');
    }
  });
});
