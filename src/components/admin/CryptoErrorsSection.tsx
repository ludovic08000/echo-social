import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ShieldAlert, RefreshCw, Trash2, Search } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';

interface CryptoLog {
  id: string;
  user_id: string;
  created_at: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  context: string;
  error_code: string;
  error_message: string;
  conversation_id: string | null;
  my_device_id: string | null;
  peer_user_id: string | null;
  peer_device_id: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
}

const SEVERITY_COLOR: Record<string, string> = {
  info: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  error: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  critical: 'bg-red-600/25 text-red-100 border-red-600/50',
};

export function CryptoErrorsSection() {
  const [logs, setLogs] = useState<CryptoLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [severity, setSeverity] = useState<string>('all');
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    let q = supabase
      .from('crypto_error_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (severity !== 'all') q = q.eq('severity', severity);
    const { data, error } = await q;
    if (error) {
      toast({ title: 'Erreur', description: error.message, variant: 'destructive' });
    } else {
      setLogs((data ?? []) as unknown as CryptoLog[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severity]);

  const purge = async () => {
    if (!confirm('Purger tous les logs de plus de 30 jours ?')) return;
    const { error } = await supabase.rpc('purge_old_crypto_error_logs');
    if (error) {
      toast({ title: 'Échec purge', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Purge effectuée' });
      void load();
    }
  };

  const filtered = logs.filter(l => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      l.error_code.toLowerCase().includes(s) ||
      l.error_message.toLowerCase().includes(s) ||
      l.context.toLowerCase().includes(s) ||
      (l.user_id ?? '').toLowerCase().includes(s) ||
      (l.conversation_id ?? '').toLowerCase().includes(s)
    );
  });

  // Aggregations for the top cards
  const counts = filtered.reduce<Record<string, number>>((acc, l) => {
    acc[l.error_code] = (acc[l.error_code] ?? 0) + 1;
    return acc;
  }, {});
  const topCodes = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-primary" />
            Erreurs de chiffrement
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Journal des incidents E2EE (handshake, ratchet, fanout, queue).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Rafraîchir
          </Button>
          <Button variant="destructive" size="sm" onClick={purge}>
            <Trash2 className="w-4 h-4 mr-2" />
            Purger &gt;30j
          </Button>
        </div>
      </div>

      {/* Top error codes */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {topCodes.length === 0 ? (
          <Card className="p-4 col-span-full text-sm text-muted-foreground text-center">
            Aucun incident dans la fenêtre actuelle.
          </Card>
        ) : (
          topCodes.map(([code, count]) => (
            <Card key={code} className="p-4">
              <p className="text-xs text-muted-foreground font-mono">{code}</p>
              <p className="text-2xl font-bold mt-1">{count}</p>
            </Card>
          ))
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Rechercher (code, message, user, conv)…"
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger className="sm:w-44">
            <SelectValue placeholder="Sévérité" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toutes sévérités</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="warning">Warning</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Log table */}
      <Card className="overflow-hidden">
        <ScrollArea className="h-[60vh]">
          <div className="divide-y divide-border">
            {filtered.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {loading ? 'Chargement…' : 'Aucun log à afficher.'}
              </div>
            )}
            {filtered.map(log => (
              <div key={log.id} className="p-4 hover:bg-accent/30 transition-colors">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <Badge variant="outline" className={SEVERITY_COLOR[log.severity]}>
                    {log.severity}
                  </Badge>
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {log.context}
                  </Badge>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {log.error_code}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground ml-auto">
                    {formatDistanceToNow(new Date(log.created_at), { addSuffix: true, locale: fr })}
                  </span>
                </div>
                <p className="text-sm text-foreground break-words">{log.error_message}</p>
                <div className="text-[11px] text-muted-foreground mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 font-mono">
                  <span>user: {log.user_id.slice(0, 8)}…</span>
                  {log.conversation_id && <span>conv: {log.conversation_id.slice(0, 8)}…</span>}
                  {log.my_device_id && <span>my dev: {log.my_device_id.slice(0, 12)}…</span>}
                  {log.peer_user_id && <span>peer: {log.peer_user_id.slice(0, 8)}…</span>}
                  {log.peer_device_id && <span>peer dev: {log.peer_device_id.slice(0, 12)}…</span>}
                </div>
                {log.metadata && Object.keys(log.metadata).length > 0 && (
                  <details className="mt-2">
                    <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">
                      Détails
                    </summary>
                    <pre className="text-[10px] mt-1 p-2 bg-muted rounded overflow-x-auto">
                      {JSON.stringify(log.metadata, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </Card>
    </div>
  );
}
