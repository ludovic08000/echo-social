import { useState } from 'react';
import { ArrowLeft, Plus, Trophy, Users, Clock, Flame } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { UserAvatar } from '@/components/UserAvatar';
import { useChallenges, useCreateChallenge, useJoinChallenge, useLeaveChallenge } from '@/hooks/useChallenges';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const CHALLENGE_TYPES = [
  { value: 'photo', label: '📸 Photo du jour' },
  { value: 'quiz', label: '🧠 Quiz' },
  { value: 'sport', label: '💪 Sport' },
  { value: 'creative', label: '🎨 Créatif' },
  { value: 'social', label: '🤝 Social' },
];

export default function Challenges() {
  const navigate = useNavigate();
  const { data: challenges, isLoading } = useChallenges();
  const createChallenge = useCreateChallenge();
  const joinChallenge = useJoinChallenge();
  const leaveChallenge = useLeaveChallenge();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('photo');
  const [durationDays, setDurationDays] = useState('7');

  const handleCreate = async () => {
    if (!title.trim()) return;
    try {
      const endsAt = new Date();
      endsAt.setDate(endsAt.getDate() + parseInt(durationDays));
      await createChallenge.mutateAsync({
        title,
        description: description || undefined,
        challenge_type: type,
        ends_at: endsAt.toISOString(),
      });
      toast({ title: '🏆 Défi créé !' });
      setIsDialogOpen(false);
      setTitle('');
      setDescription('');
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const handleJoin = async (challengeId: string) => {
    try {
      await joinChallenge.mutateAsync(challengeId);
      toast({ title: '🔥 Défi accepté !' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const handleLeave = async (challengeId: string) => {
    try {
      await leaveChallenge.mutateAsync(challengeId);
      toast({ title: 'Vous avez quitté le défi' });
    } catch {
      toast({ title: 'Erreur', variant: 'destructive' });
    }
  };

  const isActive = (c: { ends_at: string }) => new Date(c.ends_at) > new Date();
  const getTimeLeft = (endsAt: string) => {
    const diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return 'Terminé';
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    return days > 0 ? `${days}j ${hours}h` : `${hours}h`;
  };

  return (
    <AppLayout>
      <div className="px-4 py-2">
        <header className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-8 w-8 rounded-full">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h1 className="text-lg font-bold">🏆 Défis</h1>
          </div>
          <Button size="sm" className="premium-button h-9 text-xs" onClick={() => setIsDialogOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Créer
          </Button>
        </header>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="premium-card p-4 animate-pulse">
                <div className="h-5 w-1/2 bg-muted rounded" />
                <div className="h-3 w-3/4 bg-muted rounded mt-2" />
              </div>
            ))}
          </div>
        ) : challenges?.length === 0 ? (
          <div className="premium-card p-10 text-center">
            <Trophy className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Aucun défi pour le moment</p>
            <Button size="sm" className="premium-button mt-4" onClick={() => setIsDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-1" /> Lancer un défi
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {challenges?.map(challenge => (
              <div key={challenge.id} className="premium-card p-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-lg flex-shrink-0">
                    {CHALLENGE_TYPES.find(t => t.value === challenge.challenge_type)?.label.split(' ')[0] || '🏆'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold truncate">{challenge.title}</h3>
                      {isActive(challenge) ? (
                        <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center gap-1">
                          <Flame className="w-3 h-3" /> Actif
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] font-semibold">
                          Terminé
                        </span>
                      )}
                    </div>
                    {challenge.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{challenge.description}</p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Users className="w-3.5 h-3.5" /> {challenge.participants_count} participants
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" /> {getTimeLeft(challenge.ends_at)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-3">
                      <UserAvatar src={challenge.creator_profile?.avatar_url} alt={challenge.creator_profile?.name} size="xs" />
                      <span className="text-xs text-muted-foreground">par {challenge.creator_profile?.name}</span>
                    </div>
                  </div>
                </div>
                {isActive(challenge) && (
                  <div className="mt-3 pt-3 border-t border-border/30">
                    {challenge.is_joined ? (
                      <Button variant="outline" size="sm" className="w-full text-xs h-8" onClick={() => handleLeave(challenge.id)}>
                        Quitter le défi
                      </Button>
                    ) : (
                      <Button size="sm" className="premium-button w-full text-xs h-8" onClick={() => handleJoin(challenge.id)}>
                        <Flame className="w-3.5 h-3.5 mr-1" /> Relever le défi
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Create challenge dialog */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Nouveau défi 🏆</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Input placeholder="Nom du défi" value={title} onChange={e => setTitle(e.target.value)} className="rounded-xl" />
              <Textarea placeholder="Description (optionnel)" value={description} onChange={e => setDescription(e.target.value)} className="rounded-xl min-h-[80px]" />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Type</label>
                  <Select value={type} onValueChange={setType}>
                    <SelectTrigger className="rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHALLENGE_TYPES.map(t => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Durée</label>
                  <Select value={durationDays} onValueChange={setDurationDays}>
                    <SelectTrigger className="rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 jour</SelectItem>
                      <SelectItem value="3">3 jours</SelectItem>
                      <SelectItem value="7">1 semaine</SelectItem>
                      <SelectItem value="14">2 semaines</SelectItem>
                      <SelectItem value="30">1 mois</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button onClick={handleCreate} disabled={!title.trim() || createChallenge.isPending} className="premium-button w-full">
                {createChallenge.isPending ? 'Création…' : 'Lancer le défi'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
