import { useState, useCallback } from 'react';
import { MapPin, Cake, GraduationCap, Briefcase, Calendar, Link2, Globe, Users, Lock, Pencil, Check, X, ChevronRight, Heart, Sparkles } from 'lucide-react';
import { Profile, FieldVisibility, useUpdateProfile } from '@/hooks/useProfile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

type VisibilityLevel = 'public' | 'friends' | 'only_me';

const visibilityConfig: Record<VisibilityLevel, { label: string; icon: React.ReactNode; color: string }> = {
  public: { label: 'Public', icon: <Globe className="w-3.5 h-3.5" />, color: 'text-emerald-400' },
  friends: { label: 'Amis', icon: <Users className="w-3.5 h-3.5" />, color: 'text-blue-400' },
  only_me: { label: 'Moi seul', icon: <Lock className="w-3.5 h-3.5" />, color: 'text-amber-400' },
};

interface AboutField {
  key: string;
  visibilityKey: keyof FieldVisibility;
  icon: React.ReactNode;
  label: string;
  getValue: (p: Profile) => string;
  placeholder: string;
}

const fields: AboutField[] = [
  {
    key: 'city',
    visibilityKey: 'city',
    icon: <MapPin className="w-[18px] h-[18px]" />,
    label: 'Habite à',
    getValue: (p) => p.city || '',
    placeholder: 'Votre ville',
  },
  {
    key: 'date_of_birth',
    visibilityKey: 'date_of_birth',
    icon: <Cake className="w-[18px] h-[18px]" />,
    label: 'Date de naissance',
    getValue: (p) => p.date_of_birth || '',
    placeholder: 'AAAA-MM-JJ',
  },
  {
    key: 'work',
    visibilityKey: 'work',
    icon: <Briefcase className="w-[18px] h-[18px]" />,
    label: 'Travaille comme',
    getValue: (p) => p.work || '',
    placeholder: 'Votre métier',
  },
  {
    key: 'education',
    visibilityKey: 'education',
    icon: <GraduationCap className="w-[18px] h-[18px]" />,
    label: 'A étudié',
    getValue: (p) => {
      const parts = [];
      if (p.education_level) parts.push(p.education_level);
      if (p.education_city) parts.push(p.education_city);
      return parts.join(' | ');
    },
    placeholder: 'Niveau d\'études',
  },
  {
    key: 'relationship_status',
    visibilityKey: 'relationship_status',
    icon: <Heart className="w-[18px] h-[18px]" />,
    label: 'Situation amoureuse',
    getValue: (p) => p.relationship_status || '',
    placeholder: 'Votre statut',
  },
  {
    key: 'interests',
    visibilityKey: 'interests',
    icon: <Sparkles className="w-[18px] h-[18px]" />,
    label: 'Centres d\'intérêt',
    getValue: (p) => (p.interests || []).join(', '),
    placeholder: 'Ex: Sport, Musique, Cuisine',
  },
];

function formatDateDisplay(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

interface ProfileAboutSectionProps {
  profile: Profile;
  isOwnProfile: boolean;
  isFriend: boolean;
}

export function ProfileAboutSection({ profile, isOwnProfile, isFriend }: ProfileAboutSectionProps) {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const updateProfile = useUpdateProfile();
  const queryClient = useQueryClient();

  const visibility: FieldVisibility = profile.field_visibility || {
    date_of_birth: 'public',
    city: 'public',
    education: 'public',
    work: 'public',
    relationship_status: 'public',
    interests: 'public',
  };

  const canSeeField = useCallback((visKey: keyof FieldVisibility) => {
    if (isOwnProfile) return true;
    const level = visibility[visKey] || 'public';
    if (level === 'public') return true;
    if (level === 'friends' && isFriend) return true;
    return false;
  }, [isOwnProfile, isFriend, visibility]);

  const startEditing = (field: AboutField) => {
    if (field.key === 'education') {
      setEditValues({
        education_level: profile.education_level || '',
        education_city: profile.education_city || '',
      });
    } else {
      setEditValues({ [field.key]: field.getValue(profile) });
    }
    setEditingField(field.key);
  };

  const cancelEditing = () => {
    setEditingField(null);
    setEditValues({});
  };

  const saveField = async (field: AboutField) => {
    try {
      if (field.key === 'education') {
        await updateProfile.mutateAsync({
          education_level: editValues.education_level?.trim() || null,
          education_city: editValues.education_city?.trim() || null,
        } as any);
      } else if (field.key === 'date_of_birth') {
        const val = editValues.date_of_birth?.trim() || null;
        if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
          toast({ title: 'Format invalide', description: 'Utilisez le format AAAA-MM-JJ', variant: 'destructive' });
          return;
        }
        await updateProfile.mutateAsync({ date_of_birth: val } as any);
      } else if (field.key === 'interests') {
        const raw = editValues.interests?.trim() || '';
        const arr = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
        await updateProfile.mutateAsync({ interests: arr.length > 0 ? arr : null } as any);
      } else {
        await updateProfile.mutateAsync({ [field.key]: editValues[field.key]?.trim() || null } as any);
      }
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      setEditingField(null);
      setEditValues({});
      toast({ title: 'Mis à jour !' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const changeVisibility = async (visKey: keyof FieldVisibility, level: VisibilityLevel) => {
    const newVisibility = { ...visibility, [visKey]: level };
    try {
      await updateProfile.mutateAsync({ field_visibility: newVisibility });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      toast({ title: `Visibilité : ${visibilityConfig[level].label}` });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const getDisplayValue = (field: AboutField): string | null => {
    if (field.key === 'date_of_birth') {
      return profile.date_of_birth ? formatDateDisplay(profile.date_of_birth) : null;
    }
    if (field.key === 'education') {
      if (!profile.education_level && !profile.education_city) return null;
      let text = profile.education_level || '';
      if (profile.education_city) text += ` à ${profile.education_city}`;
      return text;
    }
    if (field.key === 'work') return profile.work || null;
    if (field.key === 'city') return profile.city || null;
    if (field.key === 'relationship_status') return profile.relationship_status || null;
    if (field.key === 'interests') {
      const arr = profile.interests;
      if (!arr || arr.length === 0) return null;
      return arr.join(', ');
    }
    return null;
  };

  return (
    <div className="rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-5 pb-3 flex items-center justify-between">
        <h3 className="text-base font-bold tracking-tight">À propos</h3>
        {isOwnProfile && !editingField && (
          <span className="text-[11px] text-muted-foreground/60 font-medium">Survolez pour modifier</span>
        )}
      </div>

      {/* Fields */}
      <div className="px-2 pb-2">
        {fields.map((field, index) => {
          const visible = canSeeField(field.visibilityKey);
          const displayValue = getDisplayValue(field);
          const isEditing = editingField === field.key;
          const currentVisLevel = visibility[field.visibilityKey] || 'public';
          const hasValue = !!displayValue;

          if (!visible && !isOwnProfile) return null;

          return (
            <div key={field.key}>
              {isEditing ? (
                <div className="px-3 py-3 space-y-3 bg-secondary/30 rounded-xl mx-1 my-1">
                  <div className="flex items-center gap-2.5 text-sm font-semibold">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                      {field.icon}
                    </div>
                    <span>{field.label}</span>
                  </div>
                  {field.key === 'education' ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        value={editValues.education_level || ''}
                        onChange={e => setEditValues(v => ({ ...v, education_level: e.target.value }))}
                        placeholder="Niveau d'études"
                        className="h-10 text-sm rounded-xl bg-background/80 border-border/50 focus:border-primary/50"
                        maxLength={100}
                      />
                      <Input
                        value={editValues.education_city || ''}
                        onChange={e => setEditValues(v => ({ ...v, education_city: e.target.value }))}
                        placeholder="Ville d'études"
                        className="h-10 text-sm rounded-xl bg-background/80 border-border/50 focus:border-primary/50"
                        maxLength={100}
                      />
                    </div>
                  ) : field.key === 'date_of_birth' ? (
                    <Input
                      type="date"
                      value={editValues.date_of_birth || ''}
                      onChange={e => setEditValues(v => ({ ...v, date_of_birth: e.target.value }))}
                      className="h-10 text-sm rounded-xl bg-background/80 border-border/50 focus:border-primary/50"
                    />
                  ) : field.key === 'relationship_status' ? (
                    <Select
                      value={editValues.relationship_status || ''}
                      onValueChange={val => setEditValues(v => ({ ...v, relationship_status: val }))}
                    >
                      <SelectTrigger className="h-10 text-sm rounded-xl bg-background/80 border-border/50">
                        <SelectValue placeholder="Choisir un statut" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Célibataire">Célibataire</SelectItem>
                        <SelectItem value="En couple">En couple</SelectItem>
                        <SelectItem value="Marié(e)">Marié(e)</SelectItem>
                        <SelectItem value="Fiancé(e)">Fiancé(e)</SelectItem>
                        <SelectItem value="Divorcé(e)">Divorcé(e)</SelectItem>
                        <SelectItem value="Veuf/Veuve">Veuf/Veuve</SelectItem>
                        <SelectItem value="C'est compliqué">C'est compliqué</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : field.key === 'interests' ? (
                    <div className="space-y-1.5">
                      <Input
                        value={editValues.interests || ''}
                        onChange={e => setEditValues(v => ({ ...v, interests: e.target.value }))}
                        placeholder="Sport, Musique, Cuisine, Voyage..."
                        className="h-10 text-sm rounded-xl bg-background/80 border-border/50 focus:border-primary/50"
                        maxLength={200}
                      />
                      <p className="text-[10px] text-muted-foreground/60">Séparez par des virgules</p>
                    </div>
                  ) : (
                    <Input
                      value={editValues[field.key] || ''}
                      onChange={e => setEditValues(v => ({ ...v, [field.key]: e.target.value }))}
                      placeholder={field.placeholder}
                      className="h-10 text-sm rounded-xl bg-background/80 border-border/50 focus:border-primary/50"
                      maxLength={100}
                    />
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-8 text-xs rounded-lg px-4 gap-1.5"
                      onClick={() => saveField(field)}
                      disabled={updateProfile.isPending}
                    >
                      <Check className="w-3.5 h-3.5" /> Enregistrer
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs rounded-lg px-4 gap-1.5 text-muted-foreground"
                      onClick={cancelEditing}
                    >
                      <X className="w-3.5 h-3.5" /> Annuler
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  className={cn(
                    "group flex items-center gap-3 px-3 py-3 rounded-xl mx-1 transition-all duration-200",
                    isOwnProfile && "hover:bg-secondary/40 cursor-pointer",
                    !hasValue && isOwnProfile && "opacity-60 hover:opacity-100"
                  )}
                  onClick={() => isOwnProfile && startEditing(field)}
                >
                  {/* Icon */}
                  <div className={cn(
                    "w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-colors",
                    hasValue ? "bg-primary/10 text-primary" : "bg-muted/60 text-muted-foreground"
                  )}>
                    {field.icon}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    {hasValue ? (
                      <>
                        <p className="text-sm font-medium text-foreground leading-tight">{displayValue}</p>
                        <p className="text-[11px] text-muted-foreground/70 mt-0.5">{field.label}</p>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">
                        {isOwnProfile ? `Ajouter ${field.label.toLowerCase()}` : 'Non renseigné'}
                      </p>
                    )}
                  </div>

                  {/* Actions (own profile only) */}
                  {isOwnProfile && (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200" onClick={e => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className={cn(
                              "h-7 w-7 rounded-full flex items-center justify-center transition-colors hover:bg-background/80",
                              visibilityConfig[currentVisLevel].color
                            )}
                            title={`Visible par : ${visibilityConfig[currentVisLevel].label}`}
                          >
                            {visibilityConfig[currentVisLevel].icon}
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[160px] rounded-xl border-border/50 bg-card/95 backdrop-blur-lg">
                          <p className="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Qui peut voir</p>
                          {(Object.keys(visibilityConfig) as VisibilityLevel[]).map(level => (
                            <DropdownMenuItem
                              key={level}
                              onClick={() => changeVisibility(field.visibilityKey, level)}
                              className={cn(
                                "gap-2.5 text-sm rounded-lg mx-1 cursor-pointer",
                                currentVisLevel === level && "bg-primary/10"
                              )}
                            >
                              <span className={visibilityConfig[level].color}>{visibilityConfig[level].icon}</span>
                              <span className="flex-1">{visibilityConfig[level].label}</span>
                              {currentVisLevel === level && <Check className="w-3.5 h-3.5 text-primary" />}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <button
                        className="h-7 w-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background/80 transition-colors"
                        onClick={() => startEditing(field)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  {/* Chevron for own profile */}
                  {isOwnProfile && (
                    <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors flex-shrink-0" />
                  )}
                </div>
              )}

              {/* Separator */}
              {index < fields.length - 1 && !isEditing && (
                <div className="mx-5 border-b border-border/20" />
              )}
            </div>
          );
        })}

        {/* Divider */}
        <div className="mx-5 my-1 border-b border-border/30" />

        {/* Static fields */}
        {profile.website_url && (
          <div className="flex items-center gap-3 px-3 py-3 mx-1">
            <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary flex-shrink-0">
              <Link2 className="w-[18px] h-[18px]" />
            </div>
            <div className="flex-1 min-w-0">
              <a href={sanitizeUrl(profile.website_url)} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary hover:underline truncate block">
                {profile.website_url.replace(/^https?:\/\//, '')}
              </a>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">Site web</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 px-3 py-3 mx-1">
          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary flex-shrink-0">
            <Calendar className="w-[18px] h-[18px]" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground leading-tight">
              {new Date(profile.created_at).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}
            </p>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Membre depuis</p>
          </div>
        </div>
      </div>
    </div>
  );
}
