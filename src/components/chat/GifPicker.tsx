import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const TENOR_API_KEY = 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ'; // Public Tenor API key
const TENOR_CLIENT_KEY = 'forsure_app';

interface GifResult {
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

export function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [trending, setTrending] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedTrending, setLoadedTrending] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchGifs = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const endpoint = query.trim()
        ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&client_key=${TENOR_CLIENT_KEY}&limit=20&media_filter=gif,tinygif`
        : `https://tenor.googleapis.com/v2/featured?key=${TENOR_API_KEY}&client_key=${TENOR_CLIENT_KEY}&limit=20&media_filter=gif,tinygif`;

      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`Tenor HTTP ${res.status}`);
      const data = await res.json();

      const gifs: GifResult[] = (data.results || [])
        .map((r: any) => ({
          id: String(r.id || crypto.randomUUID?.() || Math.random()),
          url: r.media_formats?.gif?.url || r.media_formats?.tinygif?.url || '',
          preview: r.media_formats?.tinygif?.url || r.media_formats?.gif?.url || '',
          width: r.media_formats?.tinygif?.dims?.[0] || 200,
          height: r.media_formats?.tinygif?.dims?.[1] || 200,
        }))
        .filter((gif: GifResult) => gif.url.startsWith('https://') && gif.preview.startsWith('https://'));

      if (query.trim()) {
        setResults(gifs);
      } else {
        setTrending(gifs);
        setLoadedTrending(true);
      }
    } catch (err) {
      console.error('GIF fetch error:', err);
      if (query.trim()) setResults([]);
      else {
        setTrending([]);
        setLoadedTrending(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Load trending on mount. This must be an effect, not a useState initializer:
  // initializers are for pure state creation and can behave badly under remounts.
  useEffect(() => {
    if (!loadedTrending) void fetchGifs('');
  }, [fetchGifs, loadedTrending]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSearch = (value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (value.trim()) {
        fetchGifs(value);
      } else {
        setResults([]);
      }
    }, 400);
  };

  const displayGifs = search.trim() ? results : trending;

  return (
    <div className="border-t border-border/20 bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-2.5 pt-2 pb-1">
        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">GIFs</span>
        <button onClick={onClose} className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-secondary transition-colors">
          <X className="w-3 h-3 text-muted-foreground" />
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 pb-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <input
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Rechercher un GIF…"
            className="w-full bg-secondary/60 rounded-lg pl-7 pr-3 py-1.5 text-[11px] outline-none placeholder:text-muted-foreground focus:bg-secondary transition-colors"
            autoFocus
          />
        </div>
      </div>

      {/* Grid */}
      <div className="px-1.5 pb-2 max-h-[160px] overflow-y-auto scrollbar-thin">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
          </div>
        ) : displayGifs.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-[10px] text-muted-foreground">
              {search.trim() ? 'Aucun GIF trouvé' : 'Aucun GIF disponible'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1">
            {displayGifs.map(gif => (
              <button
                key={gif.id}
                onClick={() => onSelect(gif.url)}
                className="rounded-lg overflow-hidden hover:opacity-80 active:scale-95 transition-all aspect-square bg-muted"
              >
                <img
                  src={gif.preview}
                  alt="GIF"
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tenor attribution */}
      <div className="px-2.5 pb-1.5 flex justify-end">
        <span className="text-[8px] text-muted-foreground/50">Powered by Tenor</span>
      </div>
    </div>
  );
}
