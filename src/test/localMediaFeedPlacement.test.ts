import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const feed = readFileSync(resolve(process.cwd(), 'src/pages/Feed.tsx'), 'utf8');

describe('local media feed placement', () => {
  it('keeps news available on an empty feed and blends it into populated pages', () => {
    expect(feed).toContain('<LocalMediaSection maxItems=');
    expect(feed).toContain('editorialMediaSlotAfterPost(index, editorialBlendPlan)');
    expect(feed).toContain('<LocalMediaSection variant="feed-card" itemIndex={editorialSlot} />');
    expect(feed).not.toContain("10: 'local_news'");
  });
});
