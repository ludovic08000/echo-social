import { useState, useEffect, useRef } from 'react';
import { Brain, Shuffle, Users, Clock, EyeOff, Sparkles, Hash, Sliders } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { loadContentPrefs, loadFeedWeights, type ContentPrefs, type FeedWeights } from '@/lib/feedAlgorithm';
import { CONTENT_PREFS_CHANGED_EVENT, saveFeedPrefs, syncFeedPrefsFromServer } from '@/lib/feedPreferences';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

type FeedAlgorithm = ContentPrefs['feedAlgorithm'];

const topicOptions = [
  { value: 'technology', labelKey: 'content.topicTech' },
  { value: 'sport', labelKey: 'content.topicSport' },
  { value: 'art', labelKey: 'content.topicArt' },
  { value: 'music', labelKey: 'content.topicMusic' },
  { value: 'cooking', labelKey: 'content.topicCooking' },
  { value: 'travel', labelKey: 'content.topicTravel' },
  { value: 'science', labelKey: 'content.topicScience' },
  { value: 'fashion', labelKey: 'content.topicFashion' },
  { value: 'cinema', labelKey: 'content.topicCinema' },
  { value: 'literature', labelKey: 'content.topicLiterature' },
  { value: 'gaming', labelKey: 'content.topicGaming' },
  { value: 'nature', labelKey: 'content.topicNature' },
];

export function ContentPreferencesPanel() {
  const { t } = useTranslation();

  const algorithmOptions: { id: FeedAlgorithm; label: string; desc: string; icon: React.ReactNode }[] = [
    { id: 'smart', label: t('content.smart'), desc: t('content.smartDesc'), icon: <Brain className="w-4 h-4" /> },
    { id: 'chronological', label: t('content.chronological'), desc: t('content.chronologicalDesc'), icon: <Clock className="w-4 h-4" /> },
    { id: 'friends_first', label: t('content.friendsFirst'), desc: t('content.friendsFirstDesc'), icon: <Users className="w-4 h-4" /> },
  ];

  const [prefs, setPrefs] = useState<ContentPrefs>(loadContentPrefs);
  const [feedWeights, setFeedWeights] = useState<FeedWeights>(loadFeedWeights);
  const [newKeyword, setNewKeyword] = useState('');

  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const hydratedRef = useRef(false);

  // Pull DB-backed prefs on mount, then re-hydrate UI from refreshed cache
  useEffect(() => {
    hydratedRef.current = false;
    if (!userId) return;
    let cancelled = false;
    (async () => {
      await syncFeedPrefsFromServer(userId);
      if (cancelled) return;
      try {
        setPrefs(loadContentPrefs());
        const sw = localStorage.getItem('feed-weights');
        if (sw) setFeedWeights(prev => ({ ...prev, ...JSON.parse(sw) }));
      } catch {
        // Keep the current in-memory preferences if the cache is unavailable.
      }
      hydratedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // Persist server-side (debounced via effect) — local cache is updated inside saveFeedPrefs
  useEffect(() => {
    localStorage.setItem('content-prefs', JSON.stringify(prefs));
    window.dispatchEvent(new CustomEvent(CONTENT_PREFS_CHANGED_EVENT, { detail: prefs }));
    if (!userId || !hydratedRef.current) return;
    const t = setTimeout(() => {
      void saveFeedPrefs(userId, {
        feedAlgorithm: prefs.feedAlgorithm,
        aiSummariesEnabled: prefs.aiSummariesEnabled,
        autoTranslateEnabled: prefs.autoTranslateEnabled,
        diversityBoost: prefs.diversityBoost,
        mutedKeywords: prefs.mutedKeywords,
        priorityTopics: prefs.priorityTopics,
        viralContentReduce: prefs.viralContentReduce,
        sensitiveContentFilter: prefs.sensitiveContentFilter,
        seenPostsHide: prefs.seenPostsHide,
      }).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['posts', 'friends-feed'] });
      }).catch(() => {
        toast({ title: 'Préférences non enregistrées', description: 'La synchronisation avec votre compte a échoué.', variant: 'destructive' });
      });
    }, 500);
    return () => clearTimeout(t);
  }, [prefs, queryClient, userId]);

  useEffect(() => {
    localStorage.setItem('feed-weights', JSON.stringify(feedWeights));
    window.dispatchEvent(new CustomEvent(CONTENT_PREFS_CHANGED_EVENT));
    if (!userId || !hydratedRef.current) return;
    const t = setTimeout(() => {
      void saveFeedPrefs(userId, { weights: feedWeights }).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['posts', 'friends-feed'] });
      }).catch(() => {
        toast({ title: 'Pondération non enregistrée', variant: 'destructive' });
      });
    }, 500);
    return () => clearTimeout(t);
  }, [feedWeights, queryClient, userId]);

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
      update({ priorityTopics: prefs.priorityTopics.filter(value => value !== topic) });
    } else {
      update({ priorityTopics: [...prefs.priorityTopics, topic] });
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Shuffle className="w-3.5 h-3.5" />
          {t('content.feedAlgorithm')}
        </h3>
        <div className="space-y-2">
          {algorithmOptions.map(algo => (
            <button
              key={algo.id}
              onClick={() => update({ feedAlgorithm: algo.id })}
              className={cn(
                "w-full flex items-center gap-3 p-3.5 rounded-xl border-2 transition-all duration-200 text-left",
                prefs.feedAlgorithm === algo.id ? "border-primary bg-primary/5" : "border-border/30 hover:bg-secondary/30"
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

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Hash className="w-3.5 h-3.5" />
          {t('content.priorityTopics')}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {topicOptions.map(topic => (
            <button
              key={topic.value}
              onClick={() => toggleTopic(topic.value)}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 border",
                prefs.priorityTopics.includes(topic.value)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-secondary/30 text-muted-foreground border-border/30 hover:bg-secondary/50"
              )}
            >
              {t(topic.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5" />
          {t('content.diversity')}
        </h3>
        <Slider value={[prefs.diversityBoost]} onValueChange={([v]) => update({ diversityBoost: v })} min={0} max={100} step={10} />
        <div className="flex justify-between">
          <span className="text-[10px] text-muted-foreground">{t('content.familiar')}</span>
          <span className="text-[10px] text-muted-foreground">{t('content.discovery')}</span>
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          {prefs.diversityBoost < 30 ? t('content.diversityLow') :
           prefs.diversityBoost < 70 ? t('content.diversityMid') :
           t('content.diversityHigh')}
        </p>
      </div>

      {/* Feed Weights — Configurable scoring */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Sliders className="w-3.5 h-3.5" />
          Pondération du fil
        </h3>
        <div className="space-y-4">
          <div>
            <div className="flex justify-between mb-1.5">
              <Label className="text-xs">Amis proches</Label>
              <span className="text-xs font-semibold text-primary">{feedWeights.friends}%</span>
            </div>
            <Slider value={[feedWeights.friends]} onValueChange={([v]) => setFeedWeights(w => ({ ...w, friends: v }))} min={0} max={100} step={5} />
          </div>
          <div>
            <div className="flex justify-between mb-1.5">
              <Label className="text-xs">Découverte</Label>
              <span className="text-xs font-semibold text-primary">{feedWeights.discovery}%</span>
            </div>
            <Slider value={[feedWeights.discovery]} onValueChange={([v]) => setFeedWeights(w => ({ ...w, discovery: v }))} min={0} max={100} step={5} />
          </div>
          <div>
            <div className="flex justify-between mb-1.5">
              <Label className="text-xs">Marketplace</Label>
              <span className="text-xs font-semibold text-primary">{feedWeights.marketplace}%</span>
            </div>
            <Slider value={[feedWeights.marketplace]} onValueChange={([v]) => setFeedWeights(w => ({ ...w, marketplace: v }))} min={0} max={100} step={5} />
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground/50">Ajustez l'importance de chaque type de contenu dans votre fil.</p>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <EyeOff className="w-3.5 h-3.5" />
          {t('content.mutedWords')}
        </h3>
        <div className="flex gap-2">
          <Input
            value={newKeyword}
            onChange={e => setNewKeyword(e.target.value)}
            placeholder={t('content.addMutedWord')}
            className="h-9 text-sm rounded-xl bg-secondary/40 border-border/30"
            onKeyDown={e => e.key === 'Enter' && addKeyword()}
            maxLength={30}
          />
          <button onClick={addKeyword} className="px-3 h-9 rounded-xl bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors">
            {t('common.add')}
          </button>
        </div>
        {prefs.mutedKeywords.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {prefs.mutedKeywords.map(kw => (
              <Badge key={kw} variant="secondary" className="gap-1 cursor-pointer hover:bg-destructive/20 hover:text-destructive transition-colors" onClick={() => removeKeyword(kw)}>
                {kw} ×
              </Badge>
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground/50">{t('content.mutedWordsDesc')}</p>
      </div>

      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
          <Brain className="w-3.5 h-3.5" />
          {t('content.aiFunctions')}
        </h3>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('content.aiSummaries')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('content.aiSummariesDesc')}</p>
          </div>
          <Switch checked={prefs.aiSummariesEnabled} onCheckedChange={v => update({ aiSummariesEnabled: v })} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('content.autoTranslate')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('content.autoTranslateDesc')}</p>
          </div>
          <Switch checked={prefs.autoTranslateEnabled} onCheckedChange={v => update({ autoTranslateEnabled: v })} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('content.reduceViral')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('content.reduceViralDesc')}</p>
          </div>
          <Switch checked={prefs.viralContentReduce} onCheckedChange={v => update({ viralContentReduce: v })} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('content.sensitiveFilter')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('content.sensitiveFilterDesc')}</p>
          </div>
          <Switch checked={prefs.sensitiveContentFilter} onCheckedChange={v => update({ sensitiveContentFilter: v })} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Masquer les publications déjà vues</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Évite de reproposer les contenus déjà consultés.</p>
          </div>
          <Switch checked={prefs.seenPostsHide} onCheckedChange={v => update({ seenPostsHide: v })} />
        </div>
      </div>
    </div>
  );
}
