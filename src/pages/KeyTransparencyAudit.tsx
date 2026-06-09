import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Hash,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchVerifiedTreeHeads,
  type KeyTransparencyVerifiedHead,
} from '@/lib/crypto/keyTransparency';

const PAGE_SIZE = 20;

export default function KeyTransparencyAudit() {
  const [heads, setHeads] = useState<KeyTransparencyVerifiedHead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setRefreshing(true);
    setLoadError(null);
    try {
      setHeads(await fetchVerifiedTreeHeads(PAGE_SIZE));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Helmet>
        <title>Audit transparence des cles - ForSure</title>
        <meta
          name="description"
          content="Verifiez les epoques Merkle signees du registre de transparence des cles ForSure."
        />
      </Helmet>

      <header className="sticky top-0 z-10 backdrop-blur bg-background/70 border-b border-border">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-2">
          <Link to="/settings" className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="font-display text-lg flex-1">Transparence des cles</h1>
          <Button size="sm" variant="ghost" disabled={refreshing} onClick={load}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <p className="text-sm text-muted-foreground">
          Le registre ci-dessous est public, signe par le serveur, puis verifie localement dans ce navigateur.
          Une signature invalide ou une rupture de chaine indique que la liste de cles ne doit pas etre consideree fiable.
        </p>

        {loading && (
          <>
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
          </>
        )}

        {loadError && (
          <Card className="p-4 border-destructive/40 bg-destructive/5 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Audit indisponible : {loadError}
            </div>
          </Card>
        )}

        {!loading && !loadError && heads.length === 0 && (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Aucune epoque publiee pour le moment. La premiere publication se declenchera des que de nouvelles cles sont enregistrees.
          </Card>
        )}

        {heads.map((head) => {
          const verified = head.signatureOk && head.chainOk;
          return (
            <Card key={head.epoch} className="p-4 rounded-2xl border-border/60">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="font-mono text-sm font-medium">Epoque #{head.epoch}</div>
                <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
                  <span className={`inline-flex items-center gap-1 ${verified ? 'text-green-600' : 'text-destructive'}`}>
                    {verified ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                    {verified ? 'Verifiee' : 'Anomalie'}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(head.createdAt).toLocaleString('fr-FR')}
                  </span>
                </div>
              </div>

              <div className="text-xs text-muted-foreground mb-1">
                {head.leafCount} entrees incluses
              </div>
              <div className="flex items-start gap-1.5 text-xs font-mono break-all bg-muted/40 rounded-lg p-2 mb-2">
                <Hash className="h-3 w-3 mt-0.5 shrink-0 opacity-60" />
                <span>{head.rootHash}</span>
              </div>

              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Signature, cle et chaine
                </summary>
                <div className="mt-2 space-y-1 font-mono break-all opacity-80">
                  <div><span className="opacity-60">key_id: </span>{head.signingKeyId}</div>
                  <div><span className="opacity-60">prev: </span>{head.prevEpoch ?? 'genesis'}</div>
                  <div><span className="opacity-60">sig_ok: </span>{String(head.signatureOk)}</div>
                  <div><span className="opacity-60">chain_ok: </span>{String(head.chainOk)}</div>
                  <div><span className="opacity-60">sig: </span>{head.signatureHex}</div>
                  {head.error && <div><span className="opacity-60">err: </span>{head.error}</div>}
                </div>
              </details>
            </Card>
          );
        })}
      </main>
    </div>
  );
}
