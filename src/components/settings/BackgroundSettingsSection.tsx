import { useState, useRef } from 'react';
import { Upload, Check, X, Image, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProfile, useUpdateProfile } from '@/hooks/useProfile';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

const PREDEFINED_BACKGROUNDS = [
  { id: 'none', label: 'Aucun', preview: 'bg-background', url: '' },
  { id: 'gradient-sunset', label: 'Coucher de soleil', preview: 'bg-gradient-to-br from-orange-400 via-pink-500 to-purple-600', url: 'gradient:from-orange-400,via-pink-500,to-purple-600' },
  { id: 'gradient-ocean', label: 'Océan', preview: 'bg-gradient-to-br from-cyan-400 via-blue-500 to-indigo-600', url: 'gradient:from-cyan-400,via-blue-500,to-indigo-600' },
  { id: 'gradient-forest', label: 'Forêt', preview: 'bg-gradient-to-br from-emerald-400 via-green-500 to-teal-600', url: 'gradient:from-emerald-400,via-green-500,to-teal-600' },
  { id: 'gradient-night', label: 'Nuit', preview: 'bg-gradient-to-br from-slate-800 via-indigo-900 to-black', url: 'gradient:from-slate-800,via-indigo-900,to-black' },
  { id: 'gradient-rose', label: 'Rose', preview: 'bg-gradient-to-br from-rose-300 via-pink-400 to-fuchsia-500', url: 'gradient:from-rose-300,via-pink-400,to-fuchsia-500' },
  { id: 'gradient-aurora', label: 'Aurore', preview: 'bg-gradient-to-br from-green-300 via-cyan-400 to-purple-500', url: 'gradient:from-green-300,via-cyan-400,to-purple-500' },
  { id: 'gradient-warm', label: 'Chaleur', preview: 'bg-gradient-to-br from-amber-300 via-orange-400 to-red-500', url: 'gradient:from-amber-300,via-orange-400,to-red-500' },
  { id: 'gradient-minimal', label: 'Minimal', preview: 'bg-gradient-to-br from-gray-100 via-gray-200 to-gray-300 dark:from-gray-800 dark:via-gray-900 dark:to-black', url: 'gradient:from-gray-100,via-gray-200,to-gray-300' },
];

interface BackgroundPickerProps {
  type: 'profile' | 'feed';
  currentUrl: string | null;
  onUpdate: (url: string | null) => void;
  isUpdating: boolean;
}

function BackgroundPicker({ type, currentUrl, onUpdate, isUpdating }: BackgroundPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const label = type === 'profile' ? 'Profil' : 'Feed';

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Format non supporté');
      return;
    }

    setUploading(true);
    try {
      const ext = file.name.split('.').pop();
      const fileName = `bg-${type}-${Date.now()}.${ext}`;
      const path = `backgrounds/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, file, { contentType: file.type });

      if (uploadError) throw uploadError;

      const { data } = supabase.storage.from('avatars').getPublicUrl(path);
      onUpdate(data.publicUrl);
      toast.success(`Fond ${label} mis à jour !`);
    } catch (err) {
      toast.error('Erreur lors de l\'upload');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSelect = (bg: typeof PREDEFINED_BACKGROUNDS[0]) => {
    onUpdate(bg.url || null);
    toast.success(bg.url ? `Fond "${bg.label}" appliqué` : `Fond ${label} supprimé`);
  };

  const isSelected = (bg: typeof PREDEFINED_BACKGROUNDS[0]) => {
    if (!currentUrl && !bg.url) return true;
    return currentUrl === bg.url;
  };

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <Image className="w-3.5 h-3.5" />
        Fond {label}
      </h4>

      <div className="grid grid-cols-4 gap-2">
        {PREDEFINED_BACKGROUNDS.map(bg => (
          <button
            key={bg.id}
            onClick={() => handleSelect(bg)}
            disabled={isUpdating}
            className={cn(
              "aspect-[3/4] rounded-xl border-2 transition-all duration-200 relative overflow-hidden",
              isSelected(bg)
                ? "border-primary shadow-md ring-1 ring-primary/30"
                : "border-border/30 hover:border-primary/50"
            )}
          >
            <div className={cn("absolute inset-0", bg.preview)} />
            {isSelected(bg) && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                <Check className="w-4 h-4 text-white drop-shadow-lg" />
              </div>
            )}
            <span className="absolute bottom-1 left-1 right-1 text-[8px] text-white font-medium drop-shadow-lg text-center truncate">
              {bg.label}
            </span>
          </button>
        ))}

        {/* Upload custom */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || isUpdating}
          className={cn(
            "aspect-[3/4] rounded-xl border-2 border-dashed border-border/50 transition-all duration-200 flex flex-col items-center justify-center gap-1 hover:border-primary/50 hover:bg-primary/5",
            currentUrl && !currentUrl.startsWith('gradient:') && "border-primary bg-primary/5"
          )}
        >
          {uploading ? (
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <Upload className="w-4 h-4 text-muted-foreground" />
              <span className="text-[8px] text-muted-foreground">Upload</span>
            </>
          )}
        </button>
      </div>

      {/* Preview of custom uploaded bg */}
      {currentUrl && !currentUrl.startsWith('gradient:') && (
        <div className="relative rounded-xl overflow-hidden h-16">
          <img src={currentUrl} alt="Fond actuel" className="w-full h-full object-cover" />
          <button
            onClick={() => onUpdate(null)}
            className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white hover:bg-destructive transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleUpload}
        className="hidden"
      />
    </div>
  );
}

export function BackgroundSettingsSection() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const updateProfile = useUpdateProfile();

  if (!user || !profile) return null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Fond d'écran personnalisé
        </h3>
      </div>

      <BackgroundPicker
        type="profile"
        currentUrl={(profile as any).profile_bg_url}
        onUpdate={(url) => updateProfile.mutate({ profile_bg_url: url } as any)}
        isUpdating={updateProfile.isPending}
      />

      <BackgroundPicker
        type="feed"
        currentUrl={(profile as any).feed_bg_url}
        onUpdate={(url) => updateProfile.mutate({ feed_bg_url: url } as any)}
        isUpdating={updateProfile.isPending}
      />
    </div>
  );
}
