import { useState, useCallback } from 'react';
import { MapPin, Cake, GraduationCap, Briefcase, Calendar, Link2, Globe, Users, Lock, Pencil, Check, X } from 'lucide-react';
import { Profile, FieldVisibility, useUpdateProfile } from '@/hooks/useProfile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';

type VisibilityLevel = 'public' | 'friends' | 'only_me';

const visibilityLabels: Record<VisibilityLevel, { label: string; icon: React.ReactNode }> = {
  public: { label: 'Public', icon: <Globe className="w-3.5 h-3.5" /> },
  friends: { label: 'Amis', icon: <Users className="w-3.5 h-3.5" /> },
  only_me: { label: 'Moi seul', icon: <Lock className="w-3.5 h-3.5" /> },
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
    icon: <MapPin className="w-4 h-4 text-primary flex-shrink-0" />,
    label: 'Habite à',
    getValue: (p) => p.city || '',
    placeholder: 'Votre ville',
  },
  {
    key: 'date_of_birth',
    visibilityKey: 'date_of_birth',
    icon: <Cake className="w-4 h-4 text-primary flex-shrink-0" />,
    label: 'Date de naissance',
    getValue: (p) => p.date_of_birth || '',
    placeholder: 'AAAA-MM-JJ',
  },
  {
    key: 'work',
    visibilityKey: 'work',
    icon: <Briefcase className="w-4 h-4 text-primary flex-shrink-0" />,
    label: 'Travaille comme',
    getValue: (p) => p.work || '',
    placeholder: 'Votre métier',
  },
  {
    key: 'education',
    visibilityKey: 'education',
    icon: <GraduationCap className="w-4 h-4 text-primary flex-shrink-0" />,
    label: 'A étudié',
    getValue: (p) => {
      const parts = [];
      if (p.education_level) parts.push(p.education_level);
      if (p.education_city) parts.push(p.education_city);
      return parts.join(' | ');
    },
    placeholder: 'Niveau d\'études',
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

  const visibility = profile.field_visibility || {
    date_of_birth: 'public',
    city: 'public',
    education: 'public',
    work: 'public',
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
      toast({ title: `Visibilité : ${visibilityLabels[level].label}` });
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
    return null;
  };

  return (
    <div className="premium-card p-4">
      <h3 className="font-semibold text-sm mb-3">À propos</h3>
      <div className="space-y-3">
        {fields.map(field => {
          const visible = canSeeField(field.visibilityKey);
          const displayValue = getDisplayValue(field);
          const isEditing = editingField === field.key;
          const currentVisLevel = visibility[field.visibilityKey] || 'public';

          if (!visible && !isOwnProfile) return null;

          return (
            <div key={field.key} className="group">
              {isEditing ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    {field.icon}
                    <span>{field.label}</span>
                  </div>
                  {field.key === 'education' ? (
                    <div className="flex gap-2">
                      <Input
                        value={editValues.education_level || ''}
                        onChange={e => setEditValues(v => ({ ...v, education_level: e.target.value }))}
                        placeholder="Niveau d'études"
                        className="h-9 text-sm"
                        maxLength={100}
                      />
                      <Input
                        value={editValues.education_city || ''}
                        onChange={e => setEditValues(v => ({ ...v, education_city: e.target.value }))}
                        placeholder="Ville d'études"
                        className="h-9 text-sm"
                        maxLength={100}
                      />
                    </div>
                  ) : field.key === 'date_of_birth' ? (
                    <Input
                      type="date"
                      value={editValues.date_of_birth || ''}
                      onChange={e => setEditValues(v => ({ ...v, date_of_birth: e.target.value }))}
                      className="h-9 text-sm"
                    />
                  ) : (
                    <Input
                      value={editValues[field.key] || ''}
                      onChange={e => setEditValues(v => ({ ...v, [field.key]: e.target.value }))}
                      placeholder={field.placeholder}
                      className="h-9 text-sm"
                      maxLength={100}
                    />
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" className="h-7 text-xs" onClick={() => saveField(field)} disabled={updateProfile.isPending}>
                      <Check className="w-3 h-3 mr-1" /> Enregistrer
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={cancelEditing}>
                      <X className="w-3 h-3 mr-1" /> Annuler
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 text-sm">
                  {field.icon}
                  <span className="text-muted-foreground flex-1">
                    {displayValue ? (
                      <>
                        {field.label}{' '}
                        <span className="font-medium text-foreground">{displayValue}</span>
                      </>
                    ) : (
                      <span className="italic">
                        {isOwnProfile ? `Ajouter : ${field.label.toLowerCase()}` : 'Non renseigné'}
                      </span>
                    )}
                  </span>

                  {isOwnProfile && (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {/* Visibility toggle */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={`Visible par : ${visibilityLabels[currentVisLevel].label}`}>
                            {visibilityLabels[currentVisLevel].icon}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[140px]">
                          {(Object.keys(visibilityLabels) as VisibilityLevel[]).map(level => (
                            <DropdownMenuItem
                              key={level}
                              onClick={() => changeVisibility(field.visibilityKey, level)}
                              className="gap-2 text-sm"
                            >
                              {visibilityLabels[level].icon}
                              {visibilityLabels[level].label}
                              {currentVisLevel === level && <Check className="w-3 h-3 ml-auto" />}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>

                      {/* Edit button */}
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEditing(field)}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Always visible: member since + website */}
        {profile.website_url && (
          <div className="flex items-center gap-3 text-sm">
            <Link2 className="w-4 h-4 text-primary flex-shrink-0" />
            <a href={profile.website_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate">
              {profile.website_url.replace(/^https?:\/\//, '')}
            </a>
          </div>
        )}
        <div className="flex items-center gap-3 text-sm">
          <Calendar className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-muted-foreground">
            Membre depuis{' '}
            <span className="font-medium text-foreground">
              {new Date(profile.created_at).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
