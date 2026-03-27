import { Bell, Heart, MessageCircle, UserPlus, Mail, Eye, Users, Volume2, VolumeX, Mic, Languages, Gauge, ShieldCheck, Radio } from 'lucide-react';
import { useNotificationSettings, useUpdateNotificationSettings } from '@/hooks/useNotificationSettings';
import { useVoiceSettings, VOICE_LANG_OPTIONS } from '@/hooks/useVoiceSettings';
import { speakNotification } from '@/hooks/useNotificationSounds';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { SOUND_OPTIONS } from '@/hooks/useNotificationSounds';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface SettingItemProps {
  icon: React.ElementType;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

function SettingItem({ icon: Icon, label, description, checked, onCheckedChange, disabled }: SettingItemProps) {
  return (
    <div className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="w-5 h-5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium">{label}</p>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="shrink-0"
      />
    </div>
  );
}

function previewSound(soundType: string) {
  try {
    const ctx = new AudioContext();
    const configs: Record<string, { freq: number; freq2?: number; dur: number; type: OscillatorType }> = {
      default: { freq: 880, freq2: 1100, dur: 0.15, type: 'sine' },
      soft: { freq: 523, dur: 0.2, type: 'sine' },
      bright: { freq: 1200, freq2: 1600, dur: 0.12, type: 'triangle' },
      bubble: { freq: 600, freq2: 900, dur: 0.18, type: 'sine' },
      chime: { freq: 1047, freq2: 1319, dur: 0.25, type: 'sine' },
    };
    const c = configs[soundType] || configs.default;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = c.type;
    osc.frequency.setValueAtTime(c.freq, now);
    if (c.freq2) osc.frequency.linearRampToValueAtTime(c.freq2, now + c.dur * 0.5);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + c.dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + c.dur);
  } catch {}
}

export function NotificationSettingsPanel() {
  const { data: settings, isLoading } = useNotificationSettings();
  const updateSettings = useUpdateNotificationSettings();
  const { voiceSettings, updateVoiceSettings } = useVoiceSettings();

  const handleToggle = async (key: keyof typeof settings, value: boolean) => {
    try {
      await updateSettings.mutateAsync({ [key]: value });
    } catch (error) {
      toast({ title: 'Erreur', description: 'Impossible de sauvegarder les paramètres', variant: 'destructive' });
    }
  };

  if (isLoading || !settings) {
    return (
      <div className="space-y-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-4 py-4 animate-pulse">
            <div className="w-10 h-10 rounded-xl bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-32 bg-muted rounded" />
              <div className="h-3 w-48 bg-muted rounded" />
            </div>
            <div className="w-11 h-6 bg-muted rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Sound settings */}
      <div>
        <h3 className="font-display text-lg font-semibold mb-4">🔊 Sons de notification</h3>
        <div className="divide-y divide-border/50">
          <SettingItem
            icon={settings.sound_enabled ? Volume2 : VolumeX}
            label="Activer les sons"
            description="Jouer un son à chaque nouvelle notification"
            checked={settings.sound_enabled}
            onCheckedChange={(v) => handleToggle('sound_enabled', v)}
            disabled={updateSettings.isPending}
          />
          {settings.sound_enabled && (
            <div className="flex items-start gap-4 py-4">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Bell className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium">Type de son</p>
                <p className="text-sm text-muted-foreground mt-0.5">Choisissez la sonnerie qui vous plaît</p>
                <div className="mt-2">
                  <Select
                    value={settings.sound_type || 'default'}
                    onValueChange={async (v) => {
                      previewSound(v);
                      try { await updateSettings.mutateAsync({ sound_type: v }); } catch {}
                    }}
                  >
                    <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SOUND_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="premium-divider" />

      {/* Voice synthesis settings */}
      <div>
        <h3 className="font-display text-lg font-semibold mb-4">🗣️ Synthèse vocale</h3>
        <div className="divide-y divide-border/50">
          <SettingItem
            icon={Mic}
            label="Activer la voix"
            description="Annonce vocale lors des nouvelles notifications"
            checked={voiceSettings.voice_enabled}
            onCheckedChange={(v) => updateVoiceSettings({ voice_enabled: v })}
          />

          {voiceSettings.voice_enabled && (
            <>
              <SettingItem
                icon={MessageCircle}
                label="Messages uniquement"
                description="Annoncer vocalement seulement les nouveaux messages"
                checked={voiceSettings.voice_messages_only}
                onCheckedChange={(v) => updateVoiceSettings({ voice_messages_only: v, voice_live_only: v ? false : voiceSettings.voice_live_only })}
              />
              <SettingItem
                icon={Radio}
                label="Lives uniquement"
                description="Annoncer vocalement seulement les démarrages de live"
                checked={voiceSettings.voice_live_only}
                onCheckedChange={(v) => updateVoiceSettings({ voice_live_only: v, voice_messages_only: v ? false : voiceSettings.voice_messages_only })}
              />
              <SettingItem
                icon={ShieldCheck}
                label="Ne jamais lire le contenu privé"
                description="Garantit que seul le type de notification est annoncé, jamais le contenu"
                checked={voiceSettings.voice_never_read_private}
                onCheckedChange={(v) => updateVoiceSettings({ voice_never_read_private: v })}
              />

              {/* Volume */}
              <div className="flex items-start gap-4 py-4">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Volume2 className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium">Volume de la voix</p>
                  <p className="text-sm text-muted-foreground mt-0.5">{Math.round(voiceSettings.voice_volume * 100)}%</p>
                  <div className="mt-3 pr-4">
                    <Slider
                      value={[voiceSettings.voice_volume * 100]}
                      onValueChange={([v]) => updateVoiceSettings({ voice_volume: v / 100 })}
                      min={10}
                      max={100}
                      step={5}
                    />
                  </div>
                </div>
              </div>

              {/* Speed */}
              <div className="flex items-start gap-4 py-4">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Gauge className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium">Vitesse de la voix</p>
                  <p className="text-sm text-muted-foreground mt-0.5">{voiceSettings.voice_speed.toFixed(1)}x</p>
                  <div className="mt-3 pr-4">
                    <Slider
                      value={[voiceSettings.voice_speed * 10]}
                      onValueChange={([v]) => updateVoiceSettings({ voice_speed: v / 10 })}
                      min={5}
                      max={20}
                      step={1}
                    />
                  </div>
                </div>
              </div>

              {/* Language */}
              <div className="flex items-start gap-4 py-4">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Languages className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium">Langue de la voix</p>
                  <p className="text-sm text-muted-foreground mt-0.5">Langue utilisée pour les annonces vocales</p>
                  <div className="mt-2">
                    <Select
                      value={voiceSettings.voice_lang}
                      onValueChange={(v) => updateVoiceSettings({ voice_lang: v })}
                    >
                      <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {VOICE_LANG_OPTIONS.map(opt => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Test button */}
              <div className="flex items-start gap-4 py-4">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Mic className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium">Tester la voix</p>
                  <p className="text-sm text-muted-foreground mt-0.5">Écouter un aperçu de l'annonce vocale</p>
                  <div className="mt-2 flex gap-2 flex-wrap">
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => speakNotification('message', { volume: voiceSettings.voice_volume, speed: voiceSettings.voice_speed, lang: voiceSettings.voice_lang })}>
                      💬 Message
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => speakNotification('live', { volume: voiceSettings.voice_volume, speed: voiceSettings.voice_speed, lang: voiceSettings.voice_lang })}>
                      📡 Live
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => speakNotification('comment', { volume: voiceSettings.voice_volume, speed: voiceSettings.voice_speed, lang: voiceSettings.voice_lang })}>
                      💬 Commentaire
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="premium-divider" />

      <div>
        <h3 className="font-display text-lg font-semibold mb-4">Notifications push</h3>
        <div className="divide-y divide-border/50">
          <SettingItem
            icon={Heart}
            label="Likes et réactions"
            description="Quand quelqu'un réagit à vos publications"
            checked={settings.likes_enabled}
            onCheckedChange={(v) => handleToggle('likes_enabled', v)}
            disabled={updateSettings.isPending}
          />
          <SettingItem
            icon={MessageCircle}
            label="Commentaires"
            description="Quand quelqu'un commente vos publications"
            checked={settings.comments_enabled}
            onCheckedChange={(v) => handleToggle('comments_enabled', v)}
            disabled={updateSettings.isPending}
          />
          <SettingItem
            icon={UserPlus}
            label="Demandes d'amis"
            description="Quand vous recevez une demande d'ami"
            checked={settings.friend_requests_enabled}
            onCheckedChange={(v) => handleToggle('friend_requests_enabled', v)}
            disabled={updateSettings.isPending}
          />
          <SettingItem
            icon={Bell}
            label="Messages"
            description="Quand vous recevez un nouveau message"
            checked={settings.messages_enabled}
            onCheckedChange={(v) => handleToggle('messages_enabled', v)}
            disabled={updateSettings.isPending}
          />
          <SettingItem
            icon={Eye}
            label="Vues des stories"
            description="Quand quelqu'un voit votre story"
            checked={settings.story_views_enabled}
            onCheckedChange={(v) => handleToggle('story_views_enabled', v)}
            disabled={updateSettings.isPending}
          />
          <SettingItem
            icon={Users}
            label="Posts des amis proches"
            description="Quand un ami proche publie quelque chose"
            checked={settings.close_friends_posts_enabled}
            onCheckedChange={(v) => handleToggle('close_friends_posts_enabled', v)}
            disabled={updateSettings.isPending}
          />
        </div>
      </div>

      <div className="premium-divider" />

      <div>
        <h3 className="font-display text-lg font-semibold mb-4">Email</h3>
        <div className="divide-y divide-border/50">
          <SettingItem
            icon={Mail}
            label="Notifications par email"
            description="Recevoir un résumé des notifications par email"
            checked={settings.email_notifications_enabled}
            onCheckedChange={(v) => handleToggle('email_notifications_enabled', v)}
            disabled={updateSettings.isPending}
          />
        </div>
      </div>
    </div>
  );
}
