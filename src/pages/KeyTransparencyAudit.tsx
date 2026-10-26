// Lot A5 — Key Transparency audit page.
//
// Public read-only view of server-published Merkle batches.
// Displaying a signature is not a verified trust anchor or an append-only proof.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ShieldCheck, Hash, Clock, ChevronLeft, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {configuredTransparencyKeys,transparencyCheckpointConflict,verifyTransparencyBatch,verifyTransparencyHead,type HeadVerification,type TransparencyCheckpoint} from '@/lib/crypto/ktVerification';

interface TreeHead {
  epoch: number;
  leaf_count: number;
  prev_epoch: number|null;
  root_hash: string;
  signing_key_id: string;
  signature: string;
  created_at: string;
}

const PAGE_SIZE = 20;
const CHECKPOINT_KEY='forsure:kt:verified-audit-head';
type Verification=HeadVerification|'batch_verified'|'invalid_batch'|'proof_unavailable'|'rollback_detected';
const VERIFICATION_LABELS:Record<Verification,string>={
  verified:'Signature vérifiée — inclusion non contrôlée',batch_verified:'Signature et intégrité du lot vérifiées',
  untrusted_authority:'Autorité absente de la configuration de confiance',invalid_head:'Tête de registre invalide',
  invalid_signature:'Signature invalide',verification_unavailable:'Vérification cryptographique indisponible',
  invalid_batch:'Preuve du lot invalide ou incomplète',proof_unavailable:'Preuve du lot indisponible',rollback_detected:'Régression du registre détectée',
};

export default function KeyTransparencyAudit() {
  const [heads, setHeads] = useState<TreeHead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,setError]=useState<string|null>(null);
  const [verification,setVerification]=useState<Record<number,Verification>>({});
  const loadVersion=useRef(0);

  const load = useCallback(async () => {
    const version=++loadVersion.current;
    setRefreshing(true);
    setError(null);
    try {
      const { data,error:queryError } = await supabase
        .from('e2ee_kt_tree_heads' as any)
        .select('epoch, leaf_count, prev_epoch, root_hash, signing_key_id, signature, created_at')
        .order('epoch', { ascending: false })
        .limit(PAGE_SIZE);
      if(queryError)throw queryError;
      const current=(Array.isArray(data)?data:[]).slice(0,PAGE_SIZE) as unknown as TreeHead[];
      const keys=configuredTransparencyKeys(import.meta.env.VITE_KT_PUBLIC_KEYS);
      const checked:Record<number,Verification>={};
      await Promise.all(current.map(async head=>{checked[head.epoch]=await verifyTransparencyHead(head,keys)}));
      const latest=current[0];
      if(latest&&checked[latest.epoch]==='verified'){
        let checkpoint:TransparencyCheckpoint|null=null;
        try { checkpoint=JSON.parse(localStorage.getItem(CHECKPOINT_KEY)||'null'); } catch { /* Aucune preuve locale exploitable. */ }
        if(transparencyCheckpointConflict(latest,checkpoint)) checked[latest.epoch]='rollback_detected';
        else try {
          const leaves:{leaf_index:number;leaf_hash:string}[]=[];
          for(let offset=0;offset<latest.leaf_count;offset+=1000){
            const {data:page,error:leafError}=await supabase.from('e2ee_kt_leaves' as any).select('leaf_index,leaf_hash')
              .eq('epoch',latest.epoch).order('leaf_index',{ascending:true}).range(offset,Math.min(offset+999,latest.leaf_count-1));
            if(leafError)throw leafError;
            leaves.push(...(Array.isArray(page)?page:[]) as unknown as typeof leaves);
          }
          const complete=await verifyTransparencyBatch(latest,leaves);
          checked[latest.epoch]=complete?'batch_verified':'invalid_batch';
          if(complete&&version===loadVersion.current){
            try { localStorage.setItem(CHECKPOINT_KEY,JSON.stringify({epoch:latest.epoch,root_hash:latest.root_hash})); } catch { /* La signature reste valide ; aucune persistance n'est promise. */ }
          }
        } catch { checked[latest.epoch]='proof_unavailable'; }
      }
      if(version===loadVersion.current){setHeads(current);setVerification(checked)}
    } catch {
      if(version===loadVersion.current)setError('Le registre est temporairement indisponible. Réessayez pour obtenir un état serveur confirmé.');
    } finally {
      if(version===loadVersion.current){setLoading(false);setRefreshing(false)}
    }
  },[]);

  useEffect(() => { void load(); return ()=>{loadVersion.current++}; }, [load]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Helmet>
        <title>Audit Transparence des Clés — ForSure</title>
        <meta name="description" content="Consultez les lots du registre ForSure et leur vérification locale lorsque l’autorité de confiance est configurée." />
      </Helmet>

      <header className="sticky top-0 z-10 backdrop-blur bg-background/70 border-b border-border">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-2">
          <Link to="/settings" aria-label="Retour aux paramètres" className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="font-display text-lg flex-1">Transparence des clés</h1>
          <Button size="sm" variant="ghost" aria-label="Actualiser le registre" disabled={refreshing} onClick={load}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <p className="text-sm text-muted-foreground">
          Les signatures sont contrôlées localement avec les clés publiques de confiance configurées dans l’application,
          jamais avec une clé simplement proposée par ce serveur. Le dernier lot est recomposé et comparé à sa racine signée.
          Cela ne certifie pas la continuité cumulative du registre ni les autorisations d’un appareil :
          un moniteur indépendant et la vérification des identités restent nécessaires.
        </p>
        {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}

        {loading && (
          <>
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
          </>
        )}

        {!loading && !error && heads.length === 0 && (
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
                {new Date(h.created_at).toLocaleString('fr-FR')}
              </div>
            </div>
            <div className="text-xs text-muted-foreground mb-1">{h.leaf_count} entrées dans ce lot</div>
            <p className="text-xs mb-2" role="status">{VERIFICATION_LABELS[verification[h.epoch]??'verification_unavailable']}</p>
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
