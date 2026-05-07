// Lot A5 — Key Transparency audit page.
//
// Public read-only view of the latest signed Merkle epochs. Each user can
// verify that the server is publishing keys in an append-only log: the head
// signature, batch size, and Merkle root are visible, and individual leaves
// can be expanded to compare against `e2ee_transparency_log` rows.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ShieldCheck, Hash, Clock, ChevronLeft, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface TreeHead {
  epoch: number;
  tree_size: number;
  root_hash: string;
  signing_key_id: string;
  signature: string;
  published_at: string;
}

const PAGE_SIZE = 20;

export default function KeyTransparencyAudit() {
  const [heads, setHeads] = useState<TreeHead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const { data } = await supabase
        .from('e2ee_kt_tree_heads' as any)
        .select('epoch, tree_size, root_hash, signing_key_id, signature, published_at')
        .order('epoch', { ascending: false })
        .limit(PAGE_SIZE);
      setHeads((data || []) as any);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Helmet>
        <title>Audit Transparence des Clés — ForSure</title>
        <meta name="description" content="Vérifiez publiquement les époques Merkle signées du registre de transparence des clés ForSure." />
      </Helmet>

      <header className="sticky top-0 z-10 backdrop-blur bg-background/70 border-b border-border">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-2">
          <Link to="/settings" className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="font-display text-lg flex-1">Transparence des clés</h1>
          <Button size="sm" variant="ghost" disabled={refreshing} onClick={load}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <p className="text-sm text-muted-foreground">
          Le registre Merkle ci-dessous est public et signé par le serveur. Chaque époque ajoute des feuilles
          de manière append-only — toute réécriture invalide la signature. Si vous avez un doute, comparez
          la racine d'une époque avec celle relayée par un canal indépendant.
        </p>

        {loading && (
          <>
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
          </>
        )}

        {!loading && heads.length === 0 && (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Aucune époque publiée pour le moment. La première publication se déclenchera automatiquement
            dès que de nouvelles clés sont enregistrées.
          </Card>
        )}

        {heads.map((h) => (
          <Card key={h.epoch} className="p-4 rounded-2xl border-border/60">
            <div className="flex items-center justify-between mb-2">
              <div className="font-mono text-sm font-medium">Époque #{h.epoch}</div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {new Date(h.published_at).toLocaleString('fr-FR')}
              </div>
            </div>
            <div className="text-xs text-muted-foreground mb-1">{h.tree_size} clés cumulées</div>
            <div className="flex items-start gap-1.5 text-xs font-mono break-all bg-muted/40 rounded-lg p-2 mb-2">
              <Hash className="h-3 w-3 mt-0.5 shrink-0 opacity-60" />
              <span>{h.root_hash}</span>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Signature & clé de signature
              </summary>
              <div className="mt-2 space-y-1 font-mono break-all opacity-80">
                <div><span className="opacity-60">key_id: </span>{h.signing_key_id}</div>
                <div><span className="opacity-60">sig: </span>{h.signature}</div>
              </div>
            </details>
          </Card>
        ))}
      </main>
    </div>
  );
}
