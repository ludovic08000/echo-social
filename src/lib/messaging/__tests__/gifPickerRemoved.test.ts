import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('GIF picker retirement', () => {
  it.each(['src/components/ChatWidget.tsx', 'src/components/CommentsList.tsx'])(
    'removes GIF discovery and sending controls from %s without removing media attachments', (path) => {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/GifPicker|showGifs|setShowGifs|handleGifSelect/);
      expect(source).not.toContain('api.giphy.com');
      expect(source).toContain('fileInputRef');
      expect(source.includes('type="file"')).toBe(true);
    },
  );

  it('removes the third-party picker but retains historic GIF rendering', () => {
    expect(existsSync('src/components/chat/GifPicker.tsx')).toBe(false);
    expect(readFileSync('src/components/ChatWidget.tsx', 'utf8')).toContain('isGifMessage');
    expect(readFileSync('src/components/messages/DecryptedMessageBody.tsx', 'utf8')).toContain('GIF:');
  });
});
