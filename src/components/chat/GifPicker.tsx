import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, X, Loader2, RefreshCw } from 'lucide-react';

const GIPHY_API_KEY = (import.meta.env.VITE_GIPHY_API_KEY || 'O9bC3d0aKxZHD5RQNNUFDgH60cQfgLH5').trim();

export interface GifResult {
  id: string;
  url: string;
  preview: string;
  width: number;
  height: number;
}

interface GifPickerProps {
  onSelect: (gifUrl: string) => void;
  onClose: () => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

export function isTrustedGiphyMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && (
      parsed.hostname === 'giphy.com' || parsed.hostname.endsWith('.giphy.com')
    );
  } catch {
    return false;
  }
}

export function normalizeGiphyResults(data: unknown): GifResult[] {
  const rows = asRecord(data).data;
  if (!Array.isArray(rows)) return [];

  return rows.flatMap((value, index) => {
    const result = asRecord(value);
    const images = asRecord(result.images);
    const original = asRecord(images.original);
    const downsized = asRecord(images.downsized);
    const fixedWidth = asRecord(images.fixed_width);
    const fixedWidthSmall = asRecord(images.fixed_width_small);
    const url = String(original.url || downsized.url || fixedWidth.url || '');
    const preview = String(fixedWidthSmall.url || fixedWidth.url || downsized.url || '');

    if (!isTrustedGiphyMediaUrl(url) || !isTrustedGiphyMediaUrl(preview)) return [];

    return [{
      id: String(result.id || `giphy-${index}-${url}`),
      url,
      preview,
      width: Number(fixedWidthSmall.width || fixedWidth.width || 200),
      height: Number(fixedWidthSmall.height || fixedWidth.height || 200),
    }];
  });
}

interface FetchFromGiphyOptions {
  apiKey?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

export async function fetchFromGiphy(
  query: string,
  {
    apiKey = GIPHY_API_KEY,
    fetcher = fetch,
    signal,
  }: FetchFromGiphyOptions = {},
): Promise<GifResult[]> {
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) throw new Error('GIPHY_NOT_CONFIGURED');

  const params = new URLSearchParams({
    api_key: normalizedKey,
    limit: '20',
    rating: 'pg-13',
    lang: 'fr',
    bundle: 'messaging_non_clips',
    remove_low_contrast: 'true',
  });

  const normalizedQuery = query.trim().slice(0, 50);
  if (normalizedQuery) params.set('q', normalizedQuery);
  const path = normalizedQuery ? 'search' : 'trending';
  const response = await fetcher(
    `https://api.giphy.com/v1/gifs/${path}?${params.toString()}`,
    { headers: { Accept: 'application/json' }, signal },
  );

  if (!response.ok) {
    const error = new Error(`GIPHY HTTP ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return normalizeGiphyResults(await response.json());
}

export function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [trending, setTrending] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedTrending, setLoadedTrending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchGifs = useCallback(async (query: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setErrorMessage(null);

    try {
      const gifs = await fetchFromGiphy(query, { signal: controller.signal });
      if (requestId !== requestIdRef.current) return;

      if (query.trim()) {
        setResults(gifs);
      } else {
        setTrending(gifs);
        setLoadedTrending(true);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestId !== requestIdRef.current) return;
      const message = error instanceof Error ? error.message : String(error);

      if (message === 'GIPHY_NOT_CONFIGURED') {
        setErrorMessage('Les GIFs sont temporairement indisponibles.');
      } else if (message.includes('HTTP 403')) {
        setErrorMessage('La clé GIPHY est refusée. Vérifiez ses restrictions de domaine.');
      } else if (message.includes('HTTP 429')) {
        setErrorMessage('Limite GIPHY atteinte. Réessayez plus tard.');
      } else {
        setErrorMessage('Service GIF momentanément indisponible.');
      }

      console.warn('[GIF] GIPHY unavailable', { message });
      if (query.trim()) setResults([]);
      else {
        setTrending([]);
        setLoadedTrending(true);
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loadedTrending) void fetchGifs('');
  }, [fetchGifs, loadedTrending]);

  useEffect(() => () => {
    abortRef.current?.abort();
    requestIdRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const handleSearch = (value: string) => {
    setSearch(value);
    setErrorMessage(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (value.trim()) void fetchGifs(value);
      else setResults([]);
    }, 400);
  };

  const displayGifs = search.trim() ? results : trending;

  return (
    <div className="border-t border-border/20 bg-background">
      <div className="flex items-center justify-between px-2.5 pt-2 pb-1">
        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">GIFs</span>
        <button
          type="button"
          onClick={onClose}
          className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-secondary transition-colors"
          aria-label="Fermer les GIFs"
        >
          <X className="w-3 h-3 text-muted-foreground" />
        </button>
      </div>

      <div className="px-2.5 pb-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => handleSearch(event.target.value)}
            placeholder="Rechercher un GIF…"
            className="w-full bg-secondary/60 rounded-lg pl-7 pr-3 py-1.5 text-[11px] outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
            autoFocus
          />
        </div>
      </div>

      <div className="px-1.5 pb-2 max-h-[160px] overflow-y-auto scrollbar-thin" aria-live="polite">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
          </div>
        ) : errorMessage ? (
          <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
            <p className="text-[10px] text-muted-foreground">{errorMessage}</p>
            <button
              type="button"
              onClick={() => void fetchGifs(search)}
              className="inline-flex items-center gap-1 text-[10px] underline underline-offset-2"
            >
              <RefreshCw className="h-3 w-3" />
              Réessayer
            </button>
          </div>
        ) : displayGifs.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-[10px] text-muted-foreground">
              {search.trim() ? 'Aucun GIF trouvé' : 'Aucun GIF disponible'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1">
            {displayGifs.map((gif) => (
              <button
                type="button"
                key={gif.id}
                onClick={() => onSelect(gif.url)}
                className="rounded-lg overflow-hidden hover:opacity-80 active:scale-95 transition-all aspect-square bg-muted"
              >
                <img
                  src={gif.preview}
                  alt="GIF"
                  className="w-full h-full object-cover"
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-2.5 pb-1.5 flex justify-end">
        <span className="text-[8px] text-muted-foreground/50">Powered by GIPHY</span>
      </div>
    </div>
  );
}
