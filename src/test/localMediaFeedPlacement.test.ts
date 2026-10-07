import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const feed = readFileSync(resolve(process.cwd(), 'src/pages/Feed.tsx'), 'utf8');

describe('local media feed placement', () => {
  it('renders partner news independently from the number of social posts', () => {
    const mediaSection = feed.indexOf('<LocalMediaSection />');
    const postsLoop = feed.indexOf('posts.map((post, index)');

    expect(mediaSection).toBeGreaterThan(-1);
    expect(postsLoop).toBeGreaterThan(-1);
    expect(mediaSection).toBeLessThan(postsLoop);
    expect(feed).not.toContain("10: 'local_news'");
  });
});
