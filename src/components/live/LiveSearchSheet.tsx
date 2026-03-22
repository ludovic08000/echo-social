import { useState, useMemo } from 'react';
import { Search, X, Sparkles } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

interface LiveCreator {
  id: string;
  name: string;
  avatar_url?: string | null;
  viewerCount: number;
  category: string;
  isLive: boolean;
}

interface LiveSearchSheetProps {
  open: boolean;
  onClose: () => void;
  creators: LiveCreator[];
  onSelect: (id: string) => void;
}

export function LiveSearchSheet({ open, onClose, creators, onSelect }: LiveSearchSheetProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return creators;
    const q = query.toLowerCase();
    return creators.filter(
      (c) => c.name.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)
    );
  }, [query, creators]);

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="bottom"
        className="h-[85vh] rounded-t-3xl bg-[hsl(220_20%_12%)] border-t border-white/10 p-0"
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <SheetHeader className="px-4 pt-4 pb-2">
            <div className="flex items-center justify-between">
              <SheetTitle className="text-white text-base font-semibold">Rechercher</SheetTitle>
              <button onClick={onClose} className="text-white/40 hover:text-white/70 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
          </SheetHeader>

          {/* Search input */}
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-white/5 border border-white/10 focus-within:border-[hsl(220_70%_55%/0.5)] transition-colors">
              <Search className="w-4 h-4 text-white/30" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher un créateur ou une catégorie..."
                autoFocus
                className="flex-1 bg-transparent text-white text-sm placeholder:text-white/30 outline-none"
              />
            </div>
          </div>

          {/* Zeus suggestions */}
          {!query && (
            <div className="px-4 pb-2">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="w-3.5 h-3.5" style={{ color: 'hsl(190 80% 50%)' }} />
                <span className="text-[11px] font-semibold text-white/50">Suggestions Zeus</span>
              </div>
            </div>
          )}

          {/* Results */}
          <div className="flex-1 overflow-y-auto px-4 pb-8">
            {filtered.length === 0 ? (
              <p className="text-white/30 text-sm text-center py-8">Aucun résultat</p>
            ) : (
              <div className="space-y-1">
                {filtered.map((creator) => (
                  <button
                    key={creator.id}
                    onClick={() => { onSelect(creator.id); onClose(); }}
                    className="flex items-center gap-3 w-full p-2.5 rounded-xl hover:bg-white/5 transition-colors"
                  >
                    <div className="relative">
                      <UserAvatar src={creator.avatar_url} alt={creator.name} size="md" />
                      {creator.isLive && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[hsl(220_20%_12%)]"
                          style={{ background: 'hsl(260 70% 55%)' }}
                        />
                      )}
                    </div>
                    <div className="flex-1 text-left">
                      <p className="text-white text-sm font-medium">{creator.name}</p>
                      <p className="text-white/40 text-xs">{creator.category} • {creator.viewerCount} viewers</p>
                    </div>
                    {creator.isLive && (
                      <span
                        className="px-2 py-0.5 rounded-full text-[9px] font-bold text-white"
                        style={{ background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%))' }}
                      >
                        LIVE
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
