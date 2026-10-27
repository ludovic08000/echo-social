import { describe, expect, it } from 'vitest';
import { parseFeedControlAction } from '../feedControlActions';

describe('parseFeedControlAction', () => {
  it('normalise et déduplique les thèmes explicites', () => {
    expect(parseFeedControlAction({
      type: 'update_feed_config',
      summary: 'Plus de science, moins de football',
      command: { more_topics: [' Science ', 'science'], less_topics: ['Football'] },
    })).toEqual({
      type: 'update_feed_config',
      summary: 'Plus de science, moins de football',
      command: { more_topics: ['science'], less_topics: ['football'] },
    });
  });

  it('rejette les champs inventés par le modèle', () => {
    expect(parseFeedControlAction({
      type: 'update_feed_config',
      summary: 'Test',
      command: { more_topics: ['science'], admin: true },
    })).toBeNull();
  });

  it('rejette une action vide ou hors limites', () => {
    expect(parseFeedControlAction({ type: 'update_feed_config', summary: 'Vide', command: {} })).toBeNull();
    expect(parseFeedControlAction({
      type: 'update_feed_config',
      summary: 'Trop fort',
      command: { diversity_delta: 99 },
    })).toBeNull();
  });
});
