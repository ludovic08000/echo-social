import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Archive, Eye, Download, Mail } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

export function ArchivesSection() {
  const queryClient = useQueryClient();

  const { data: archives, isLoading } = useQuery({
    queryKey: ['admin-archives'],
    queryFn: async () => {
      const { data, error } = await supabase.from('identity_theft_archives').select('*').order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      return data;
    },
  });

  const updateArchive = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Record<string, any> }) => {
      const { error } = await supabase.from('identity_theft_archives').update(updates).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: 'Dossier mis à jour' }); queryClient.invalidateQueries({ queryKey: ['admin-archives'] }); },
  });

  const generateReport = (archive: any) => {
    const report = `
═══════════════════════════════════════════════
   DOSSIER USURPATION D'IDENTITÉ
   Réf: ${archive.case_number}
   Date: ${new Date(archive.archived_at).toLocaleDateString('fr-FR')}
═══════════════════════════════════════════════

▸ USURPATEUR
  Nom utilisé : ${archive.usurper_name || 'Non renseigné'}
  Email : ${archive.usurper_email || 'Non renseigné'}
  ID utilisateur : ${archive.usurper_user_id}

▸ VICTIME
  Nom : ${archive.victim_name || 'Non renseigné'}
  ID utilisateur : ${archive.victim_user_id || 'Non renseigné'}

▸ PREUVES NUMÉRIQUES
  Adresses IP : ${(archive.ip_addresses || []).join(', ') || 'Aucune'}
  Empreintes : ${Array.isArray(archive.device_fingerprints) ? archive.device_fingerprints.length : 0}
  Logs : ${Array.isArray(archive.connection_logs) ? archive.connection_logs.length : 0}

▸ STATUT JURIDIQUE
  Plainte déposée : ${archive.legal_complaint_filed ? 'Oui' : 'Non'}
  ${archive.legal_reference ? `Référence : ${archive.legal_reference}` : ''}

═══════════════════════════════════════════════
  Généré par ForSure — ${new Date().toLocaleString('fr-FR')}
═══════════════════════════════════════════════
`.trim();
    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dossier-usurpation-${archive.case_number}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: '📄 Rapport téléchargé' });
  };

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [legalRef, setLegalRef] = useState('');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">Archives Usurpation d'Identité</h2>
        <Badge variant="secondary">{archives?.length || 0} dossier(s)</Badge>
      </div>

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 flex items-start gap-3">
          <Archive className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="text-xs space-y-1">
            <p className="font-semibold text-foreground">Dossiers juridiques</p>
            <p className="text-muted-foreground">Chaque archive contient les preuves complètes pouvant être utilisées en cas de dépôt de plainte.</p>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Chargement...</p>
      ) : !archives?.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Aucun dossier archivé</p>
      ) : archives.map(archive => (
        <Card key={archive.id} className="border-border">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {archive.usurper_avatar_url && <img src={archive.usurper_avatar_url} alt="" className="w-10 h-10 rounded-full object-cover border-2 border-destructive/30" />}
                <div>
                  <p className="text-sm font-semibold text-foreground">{archive.usurper_name || 'Inconnu'}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">{archive.case_number}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {archive.legal_complaint_filed && <Badge className="text-[10px] bg-emerald-500/10 text-emerald-700">⚖️ Plainte</Badge>}
                <Badge variant="secondary" className="text-[10px]">{format(new Date(archive.archived_at), 'dd/MM/yyyy', { locale: fr })}</Badge>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => generateReport(archive)}><Download className="w-3 h-3 mr-1" /> Rapport</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setExpandedId(expandedId === archive.id ? null : archive.id)}><Eye className="w-3 h-3 mr-1" /> {expandedId === archive.id ? 'Masquer' : 'Détails'}</Button>
              </div>
            </div>

            <div className="flex gap-4 text-xs text-muted-foreground">
              <span>🎯 Victime : <strong className="text-foreground">{archive.victim_name || '-'}</strong></span>
              <span>🌐 {(archive.ip_addresses as string[] || []).length} IP(s)</span>
              <span>📱 {Array.isArray(archive.device_fingerprints) ? archive.device_fingerprints.length : 0} empreinte(s)</span>
              {archive.usurper_email && <span><Mail className="w-3 h-3 inline mr-1" />{archive.usurper_email}</span>}
            </div>

            {expandedId === archive.id && (
              <div className="space-y-3 pt-2 border-t border-border">
                <div>
                  <p className="text-xs font-semibold text-foreground mb-1">Adresses IP</p>
                  <div className="flex flex-wrap gap-1">
                    {(archive.ip_addresses as string[] || []).length > 0 ? (archive.ip_addresses as string[]).map((ip: string) => (
                      <Badge key={ip} variant="secondary" className="text-[10px] font-mono">{ip}</Badge>
                    )) : <span className="text-xs text-muted-foreground">Aucune</span>}
                  </div>
                </div>

                <div className="bg-muted/30 rounded-lg p-3 space-y-2">
                  <p className="text-xs font-semibold text-foreground">⚖️ Suivi juridique</p>
                  {!archive.legal_complaint_filed ? (
                    <div className="flex gap-2">
                      <Input placeholder="Référence de la plainte" value={legalRef} onChange={e => setLegalRef(e.target.value)} className="flex-1 h-8 text-xs" />
                      <Button size="sm" className="h-8 text-xs" onClick={() => {
                        updateArchive.mutate({ id: archive.id, updates: { legal_complaint_filed: true, legal_complaint_date: new Date().toISOString(), legal_reference: legalRef || null } });
                        setLegalRef('');
                      }}>Marquer plainte déposée</Button>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      <p>✅ Plainte déposée le {archive.legal_complaint_date ? format(new Date(archive.legal_complaint_date), 'dd/MM/yyyy', { locale: fr }) : '-'}</p>
                      {archive.legal_reference && <p>Référence : <strong className="text-foreground">{archive.legal_reference}</strong></p>}
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
