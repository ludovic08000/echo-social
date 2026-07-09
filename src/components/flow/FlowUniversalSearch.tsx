import { useState, useRef, useEffect } from 'react';
import { Search, X, Home, Users, FileText, Settings, MessageCircle, Bot, BookOpen, Heart, Megaphone, Bell, Radio } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

const SEARCH_ITEMS = [
  { label: 'Accueil', path: '/feed', icon: Home, keywords: ['feed', 'home', 'accueil'] },
  { label: 'Amis', path: '/friends', icon: Heart, keywords: ['amis', 'friends', 'ami'] },
  { label: 'Messages', path: '/messages', icon: MessageCircle, keywords: ['messages', 'chat', 'dm', 'messagerie'] },
  { label: 'Lives', path: '/live', icon: Radio, keywords: ['live', 'stream', 'direct', 'en direct'] },
  { label: 'Groupes', path: '/groups', icon: Users, keywords: ['groupes', 'groups', 'communauté'] },
  { label: 'Pages', path: '/pages', icon: FileText, keywords: ['pages', 'page'] },
  { label: 'Journal', path: '/journal', icon: BookOpen, keywords: ['journal', 'diary', 'écrire'] },
  { label: 'Notifications', path: '/notifications', icon: Bell, keywords: ['notifications', 'notifs', 'alertes'] },
  { label: 'Publicité', path: '/ads', icon: Megaphone, keywords: ['pub', 'ads', 'publicité', 'campagne'] },
  { label: 'Zeus IA', path: '#zeus', icon: Bot, keywords: ['zeus', 'ia', 'ai', 'assistant', 'intelligence'] },
  { label: 'Réglages', path: '/settings', icon: Settings, keywords: ['réglages', 'settings', 'paramètres', 'config'] },
  { label: 'Profil', path: '/profile', icon: Users, keywords: ['profil', 'profile', 'mon compte'] },
];

export function FlowUniversalSearch() {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const filtered = query.trim()
    ? SEARCH_ITEMS.filter(item =>
        item.label.toLowerCase().includes(query.toLowerCase()) ||
        item.keywords.some(k => k.includes(query.toLowerCase()))
      )
    : SEARCH_ITEMS.slice(0, 8);

  const handleSelect = (item: typeof SEARCH_ITEMS[0]) => {
    if (item.path === '#zeus') {
      window.dispatchEvent(new Event('open-zeus'));
    } else {
      navigate(item.path);
    }
    setQuery('');
    setFocused(false);
    inputRef.current?.blur();
  };

  return (
    <div className="relative px-4 pt-3 pb-1">
      <div className={cn(
        "flex items-center gap-2.5 px-4 py-2.5 rounded-2xl border transition-all duration-300",
        focused
          ? "bg-card border-primary/40 shadow-[0_0_20px_hsl(var(--primary)/0.1)]"
          : "bg-secondary/40 border-border/20"
      )}>
        <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
          placeholder="Rechercher une fonctionnalité..."
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
        />
        {query && (
          <button onClick={() => setQuery('')} className="p-0.5">
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      <AnimatePresence>
        {focused && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.2 }}
            className="absolute left-4 right-4 top-full mt-1 z-50 bg-card/98 backdrop-blur-xl rounded-2xl border border-border/30 shadow-xl overflow-hidden max-h-[320px] overflow-y-auto"
          >
            {filtered.map(item => (
              <button
                key={item.path}
                onMouseDown={() => handleSelect(item)}
                className="flex items-center gap-3 w-full px-4 py-3 hover:bg-primary/8 transition-colors text-left"
              >
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <item.icon className="w-4 h-4 text-primary" />
                </div>
                <span className="text-sm font-medium">{item.label}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                Aucun résultat pour « {query} »
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
