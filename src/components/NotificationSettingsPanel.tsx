import { Bell, Heart, MessageCircle, UserPlus, Mail, Eye, Users } from 'lucide-react';
import { useNotificationSettings, useUpdateNotificationSettings } from '@/hooks/useNotificationSettings';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/hooks/use-toast';

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

export function NotificationSettingsPanel() {
  const { data: settings, isLoading } = useNotificationSettings();
  const updateSettings = useUpdateNotificationSettings();

  const handleToggle = async (key: keyof typeof settings, value: boolean) => {
    try {
      await updateSettings.mutateAsync({ [key]: value });
    } catch (error) {
      toast({
        title: 'Erreur',
        description: 'Impossible de sauvegarder les paramètres',
        variant: 'destructive',
      });
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
