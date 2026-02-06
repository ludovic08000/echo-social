import { useState, useEffect } from 'react';
import { Brain, Shuffle, TrendingUp, Users, Clock, EyeOff, Sparkles, Filter, Hash } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type FeedAlgorithm = 'smart' | 'chronological' | 'friends_first';

interface ContentPrefs {
  feedAlgorithm: FeedAlgorithm;
  aiSummariesEnabled: boolean;
  autoTranslateEnabled: boolean;
  sensitiveContentFilter: boolean;
  mutedKeywords: string[];
  priorityTopics: string[];
  diversityBoost: number; // 0-100
  seenPostsHide: boolean;
  viralContentReduce: boolean;
}

const defaultPrefs: ContentPrefs = {
  feedAlgorithm: 'smart',
  aiSummariesEnabled: true,
  autoTranslateEnabled: false,
  sensitiveContentFilter: true,
  mutedKeywords: [],
  priorityTopics: [],
  diversityBoost: 50,
  seenPostsHide: false,
  viralContentReduce: false,
};

const algorithmOptions: { id: FeedAlgorithm; label: string; desc: string; icon: React.ReactNode }[] = [
  { id: 'smart', label: 'Intelligent', desc: 'IA adapte le fil à vos intérêts', icon: <Brain className="w-4 h-4" /> },
  { id: 'chronological', label: 'Chronologique', desc: 'Publications les plus récentes d\'abord', icon: <Clock className="w-4 h-4" /> },
  { id: 'friends_first', label: 'Amis d\'abord', desc: 'Priorité aux amis proches', icon: <Users className="w-4 h-4" /> },
];

const suggestedTopics = ['Technologie', 'Sport', 'Art', 'Musique', 'Cuisine', 'Voyage', 'Science', 'Mode', 'Cinéma', 'Littérature', 'Gaming', 'Nature'];

export function ContentPreferencesPanel() {
  const [prefs, setPrefs] = useState<ContentPrefs>(() => {
    try {
      const saved = localStorage.getItem('content-prefs');
      return saved ? { ...defaultPrefs, ...JSON.parse(saved) } : defaultPrefs;
    } catch {
      return defaultPrefs;
    }
  });
  const [newKeyword, setNewKeyword] = useState('');

  useEffect(() => {
    localStorage.setItem('content-prefs', JSON.stringify(prefs));
  }, [prefs]);

  const update = (patch: Partial<ContentPrefs>) => {
    setPrefs(prev => ({ ...prev, ...patch }));
  };

  const addKeyword = () => {
    const kw = newKeyword.trim().toLowerCase();
    if (kw && !prefs.mutedKeywords.includes(kw)) {
      update({ mutedKeywords: [...prefs.mutedKeywords, kw] });
      setNewKeyword('');
    }
  };

  const removeKeyword = (kw: string) => {
    update({ mutedKeywords: prefs.mutedKeywords.filter(k => k !== kw) });
  };

  const toggleTopic = (topic: string) => {
    if (prefs.priorityTopics.includes(topic)) {
      update({ priorityTopics: prefs.priorityTopics.filter(t => t !== topic) });
    } else {
      update({ priorityTopics: [...prefs.priorityTopics, topic] });
    }
  };

  return (
    <div className="space-y-6">
      {/* Feed Algorithm */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Shuffle className="w-3.5 h-3.5" />
          Algorithme du fil
        </h3>
        <div className="space-y-2">
          {algorithmOptions.map(algo => (
            <button
              key={algo.id}
              onClick={() => update({ feedAlgorithm: algo.id })}
              className={cn(
                "w-full flex items-center gap-3 p-3.5 rounded-xl border-2 transition-all duration-200 text-left",
                prefs.feedAlgorithm === algo.id
                  ? "border-primary bg-primary/5"
                  : "border-border/30 hover:bg-secondary/30"
              )}
            >
              <div className={cn(
                "w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0",
                prefs.feedAlgorithm === algo.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              )}>
                {algo.icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{algo.label}</p>
                <p className="text-[11px] text-muted-foreground/70">{algo.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Priority Topics */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Hash className="w-3.5 h-3.5" />
          Sujets prioritaires
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {suggestedTopics.map(topic => (
            <button
              key={topic}
              onClick={() => toggleTopic(topic)}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 border",
                prefs.priorityTopics.includes(topic)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-secondary/30 text-muted-foreground border-border/30 hover:bg-secondary/50"
              )}
            >
              {topic}
            </button>
          ))}
        </div>
      </div>

      {/* Diversity Slider */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5" />
          Diversité du contenu
        </h3>
        <Slider
          value={[prefs.diversityBoost]}
          onValueChange={([v]) => update({ diversityBoost: v })}
          min={0}
          max={100}
          step={10}
        />
        <div className="flex justify-between">
          <span className="text-[10px] text-muted-foreground">Familier</span>
          <span className="text-[10px] text-muted-foreground">Découverte</span>
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          {prefs.diversityBoost < 30 ? "Voir surtout du contenu qui correspond à vos habitudes" :
           prefs.diversityBoost < 70 ? "Équilibre entre contenu familier et découvertes" :
           "Découvrir régulièrement de nouveaux sujets et créateurs"}
        </p>
      </div>

      {/* Muted Keywords */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <EyeOff className="w-3.5 h-3.5" />
          Mots masqués
        </h3>
        <div className="flex gap-2">
          <Input
            value={newKeyword}
            onChange={e => setNewKeyword(e.target.value)}
            placeholder="Ajouter un mot à masquer..."
            className="h-9 text-sm rounded-xl bg-secondary/40 border-border/30"
            onKeyDown={e => e.key === 'Enter' && addKeyword()}
            maxLength={30}
          />
          <button
            onClick={addKeyword}
            className="px-3 h-9 rounded-xl bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            Ajouter
          </button>
        </div>
        {prefs.mutedKeywords.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {prefs.mutedKeywords.map(kw => (
              <Badge
                key={kw}
                variant="secondary"
                className="gap-1 cursor-pointer hover:bg-destructive/20 hover:text-destructive transition-colors"
                onClick={() => removeKeyword(kw)}
              >
                {kw} ×
              </Badge>
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground/50">Les publications contenant ces mots seront masquées</p>
      </div>

      {/* AI Features */}
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
          <Brain className="w-3.5 h-3.5" />
          Fonctions IA
        </h3>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Résumés intelligents</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">L'IA résume les discussions longues</p>
          </div>
          <Switch checked={prefs.aiSummariesEnabled} onCheckedChange={v => update({ aiSummariesEnabled: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Traduction automatique</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Traduire les publications étrangères</p>
          </div>
          <Switch checked={prefs.autoTranslateEnabled} onCheckedChange={v => update({ autoTranslateEnabled: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Réduire le viral</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Limiter les contenus viraux du fil</p>
          </div>
          <Switch checked={prefs.viralContentReduce} onCheckedChange={v => update({ viralContentReduce: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Filtre contenu sensible</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Flouter le contenu potentiellement choquant</p>
          </div>
          <Switch checked={prefs.sensitiveContentFilter} onCheckedChange={v => update({ sensitiveContentFilter: v })} />
        </div>
      </div>
    </div>
  );
}
