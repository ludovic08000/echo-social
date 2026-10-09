import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Crown, Loader2, Lock, Users } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useStripeSubscription } from '@/hooks/useStripeSubscription';
import {
  FAN_CLUB_PRICES,
  formatFanClubPrice,
  useFanClub,
  useFanClubMembers,
  useMyFanSubscription,
  useSubscribeToCreator,
  useUpdateFanClub,
} from '@/hooks/useFanClub';
import { cn } from '@/lib/utils';

interface FanClubPanelProps {
  creatorId: string;
  creatorName: string;
  isOwnProfile: boolean;
}

export function FanClubPanel({ creatorId, creatorName, isOwnProfile }: FanClubPanelProps) {
  const { isCreatorSubscriber, loading: subLoading } = useStripeSubscription();
  const fanClub = useFanClub(creatorId);
  const mySubscription = useMyFanSubscription(isOwnProfile ? undefined : creatorId);
  const members = useFanClubMembers(isOwnProfile ? creatorId : undefined);
  const updateClub = useUpdateFanClub();
  const subscribe = useSubscribeToCreator();

  const [priceCents, setPriceCents] = useState<number>(fanClub.data?.monthly_price_cents ?? 299);
  const [description, setDescription] = useState<string>(fanClub.data?.description ?? '');

  useEffect(() => {
    if (fanClub.data) {
      setPriceCents(fanClub.data.monthly_price_cents ?? 299);
      setDescription(fanClub.data.description ?? '');
    }
  }, [fanClub.data]);

  const club = fanClub.data;
  const isActive = mySubscription.data?.status === 'active';
  const isPending = mySubscription.data?.status === 'pending';
  const activeMembers = (members.data ?? []).filter((m) => m.status === 'active');
  const monthlyRevenueCents = activeMembers.reduce((sum, m) => sum + (m.amount_cents ?? 0), 0);

  // Côté créateur : le badge est la seule porte d'entrée.
  if (isOwnProfile) {
    if (subLoading) {
      return (
        <div className="premium-card p-6 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Vérification du badge…
        </div>
      );
    }

    if (!isCreatorSubscriber) {
      return (
        <div className="premium-card p-6 space-y-3">
          <div className="flex items-center gap-2">
            <Crown className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold">Club d\'abonnés</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Le badge Créateur à 4,99 €/mois est nécessaire pour ouvrir un club d\'abonnés et recevoir de l\'argent.
          </p>
          <Link
            to="/creator-upgrade"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold"
          >
            <Crown className="w-3.5 h-3.5" /> Prendre le badge
          </Link>
        </div>
      );
    }

    return (
      <div className="premium-card p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Crown className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold">Mon club d\'abonnés</p>
          </div>
          <span
            className={cn(
              'text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full',
              club?.is_enabled ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-secondary text-muted-foreground'
            )}
          >
            {club?.is_enabled ? 'Ouvert' : 'Fermé'}
          </span>
        </div>

        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Prix mensuel</p>
          <div className="flex flex-wrap gap-2">
            {FAN_CLUB_PRICES.map((option) => (
              <button
                key={option.cents}
                type="button"
                onClick={() => setPriceCents(option.cents)}
                className={cn(
                  'px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all',
                  priceCents === option.cents
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-secondary/40 border-border/20 text-muted-foreground hover:bg-secondary/60'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
            Ce que promettent vos abonnés
          </p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Ex. : publications privées, bêtisiers, sons en avant-première…"
            className="w-full px-3 py-2 rounded-xl bg-secondary/40 border border-border/20 text-sm outline-none focus:border-primary/40 resize-none"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={updateClub.isPending}
            onClick={async () => {
              try {
                await updateClub.mutateAsync({
                  is_enabled: true,
                  monthly_price_cents: priceCents,
                  description,
                });
                toast({ title: 'Club ouvert', description: `Abonnement à ${formatFanClubPrice(priceCents)}` });
              } catch (error) {
                toast({
                  title: 'Impossible d\'ouvrir le club',
                  description: (error as Error).message,
                  variant: 'destructive',
                });
              }
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-60"
          >
            {updateClub.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crown className="w-3.5 h-3.5" />}
            {club?.is_enabled ? 'Mettre à jour' : 'Ouvrir mon club'}
          </button>

          {club?.is_enabled && (
            <button
              type="button"
              disabled={updateClub.isPending}
              onClick={async () => {
                try {
                  await updateClub.mutateAsync({ is_enabled: false, description });
                  toast({ title: 'Club fermé', description: 'Les nouveaux abonnements sont stoppés.' });
                } catch (error) {
                  toast({ title: 'Erreur', description: (error as Error).message, variant: 'destructive' });
                }
              }}
              className="px-4 py-2 rounded-xl bg-secondary/50 text-muted-foreground text-xs font-semibold hover:bg-secondary"
            >
              Fermer
            </button>
          )}
        </div>

        {club?.is_enabled && (
          <div className="pt-3 border-t border-border/20 flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Users className="w-3.5 h-3.5" />
              {activeMembers.length} abonné{activeMembers.length > 1 ? 's' : ''}
            </span>
            <span className="text-muted-foreground">
              Vous touchez 75 % : <span className="font-semibold text-foreground">{formatFanClubPrice(Math.round(monthlyRevenueCents * 0.75))}</span>
            </span>
          </div>
        )}
      </div>
    );
  }

  // Côté fan : rien à afficher si le club n'existe pas.
  if (fanClub.isLoading) return null;
  if (!club?.is_enabled) return null;

  return (
    <div className="premium-card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Lock className="w-4 h-4 text-primary" />
        <p className="text-sm font-semibold">Club privé de {creatorName}</p>
      </div>
      {club.description && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{club.description}</p>}
      <p className="text-lg font-bold">{formatFanClubPrice(club.monthly_price_cents)}</p>

      {isActive ? (
        <div className="flex items-center gap-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
          <Users className="w-3.5 h-3.5" /> Vous êtes abonné
          {mySubscription.data?.current_period_end
            ? ` · renouvellement le ${new Date(mySubscription.data.current_period_end).toLocaleDateString('fr-FR')}`
            : ''}
        </div>
      ) : (
        <button
          type="button"
          disabled={subscribe.isPending}
          onClick={async () => {
            try {
              await subscribe.mutateAsync(creatorId);
            } catch (error) {
              toast({
                title: 'Abonnement impossible',
                description: (error as Error).message,
                variant: 'destructive',
              });
            }
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-60"
        >
          {subscribe.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crown className="w-3.5 h-3.5" />}
          {isPending ? 'Reprendre le paiement' : 'S\'abonner'}
        </button>
      )}
    </div>
  );
}
