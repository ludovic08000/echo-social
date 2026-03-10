import { useState, useEffect } from 'react';
import { X, Forward } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

interface ShareContentPickerProps {
  onShare: (text: string) => void;
  onClose: () => void;
}

export function ShareContentPicker({ onShare, onClose }: ShareContentPickerProps) {
  const [tab, setTab] = useState<'posts' | 'products' | 'lives'>('posts');
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchItems = async () => {
      setLoading(true);
      if (tab === 'posts') {
        const { data } = await supabase.from('posts').select('id, body, image_url, created_at').order('created_at', { ascending: false }).limit(10);
        setItems((data as any[]) || []);
      } else if (tab === 'products') {
        const { data } = await supabase.from('products').select('id, title, price, thumbnail_url, created_at').eq('is_active', true).order('created_at', { ascending: false }).limit(10);
        setItems((data as any[]) || []);
      } else {
        const { data } = await supabase.from('live_streams').select('id, title, user_id, is_active, created_at').eq('is_active', true).order('created_at', { ascending: false }).limit(10);
        setItems((data as any[]) || []);
      }
      setLoading(false);
    };
    fetchItems();
  }, [tab]);

  const baseUrl = window.location.origin;

  return (
    <div className="sticky bottom-14 z-30 glass border-t border-border/20 animate-in slide-in-from-bottom-4 duration-200">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <p className="text-xs font-semibold">Partager du contenu</p>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
      </div>
      <div className="flex gap-1 px-4 pb-2">
        {[
          { key: 'posts' as const, label: '📝 Publications' },
          { key: 'products' as const, label: '🛍️ Produits' },
          { key: 'lives' as const, label: '🔴 Lives' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-3 py-1.5 rounded-full text-[10px] font-medium transition-colors',
              tab === t.key ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="px-4 pb-3 max-h-[200px] overflow-y-auto space-y-1.5">
        {loading ? (
          <div className="py-4 text-center text-xs text-muted-foreground">Chargement…</div>
        ) : items.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">Aucun contenu disponible</div>
        ) : (
          items.map(item => (
            <button
              key={item.id}
              onClick={() => {
                if (tab === 'posts') {
                  onShare(`📝 Publication partagée : ${item.body?.slice(0, 80) || 'Photo'}\n${baseUrl}/post/${item.id}`);
                } else if (tab === 'products') {
                  onShare(`🛍️ ${item.title} — ${item.price}€\n${baseUrl}/product/${item.id}`);
                } else {
                  onShare(`🔴 Live en cours : ${item.title}\n${baseUrl}/live/${item.id}`);
                }
              }}
              className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-secondary/60 transition-all text-left"
            >
              {tab === 'products' && item.thumbnail_url && (
                <img src={item.thumbnail_url} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
              )}
              {tab === 'posts' && item.image_url && (
                <img src={item.image_url} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">
                  {tab === 'posts' ? (item.body?.slice(0, 60) || 'Publication') :
                   tab === 'products' ? `${item.title} — ${item.price}€` :
                   item.title}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {tab === 'lives' ? '🔴 En direct' : formatDistanceToNow(new Date(item.created_at), { addSuffix: true, locale: fr })}
                </p>
              </div>
              <Forward className="w-4 h-4 text-primary flex-shrink-0" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}
