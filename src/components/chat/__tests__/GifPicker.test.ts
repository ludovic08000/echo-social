import { describe, expect, it, vi } from 'vitest';
import { fetchFromGiphy, normalizeGiphyResults } from '../GifPicker';

const validPayload = {
  data: [{
    id: 'gif-1',
    images: {
      original: { url: 'https://media1.giphy.com/media/gif-1/giphy.gif' },
      fixed_width_small: {
        url: 'https://media2.giphy.com/media/gif-1/100w.gif',
        width: '100',
        height: '80',
      },
    },
  }],
};

describe('GIPHY picker transport', () => {
  it('keeps only HTTPS media hosted by GIPHY', () => {
    const results = normalizeGiphyResults({
      data: [
        ...validPayload.data,
        {
          id: 'untrusted',
          images: {
            original: { url: 'https://tracker.example/gif.gif' },
            fixed_width_small: { url: 'https://tracker.example/preview.gif' },
          },
        },
      ],
    });

    expect(results).toEqual([{
      id: 'gif-1',
      url: 'https://media1.giphy.com/media/gif-1/giphy.gif',
      preview: 'https://media2.giphy.com/media/gif-1/100w.gif',
      width: 100,
      height: 80,
    }]);
  });

  it('uses Search for a query and applies safe request parameters', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(validPayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const fetcher = fetchMock as unknown as typeof fetch;

    await expect(fetchFromGiphy('  bonjour '.padEnd(80, '!'), {
      apiKey: 'web-key',
      fetcher,
    })).resolves.toHaveLength(1);

    const requested = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requested.pathname).toBe('/v1/gifs/search');
    expect(requested.searchParams.get('api_key')).toBe('web-key');
    expect(requested.searchParams.get('q')?.length).toBeLessThanOrEqual(50);
    expect(requested.searchParams.get('rating')).toBe('pg-13');
    expect(requested.searchParams.get('bundle')).toBe('messaging_non_clips');
  });

  it('fails closed when no Web API key is configured', async () => {
    await expect(fetchFromGiphy('bonjour', { apiKey: '   ' }))
      .rejects.toThrow('GIPHY_NOT_CONFIGURED');
  });
});
