import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Zap, ChevronRight, RefreshCw, Users, MessageSquare, Plus, Trash2, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SafeMarkdown } from '@/components/SafeMarkdown';

type ZMsg = { role: 'user' | 'assistant' | 'system'; content: string };
type ZConv = { id: string; title: string; updated_at: string; messages: ZMsg[] };

const QUICK_CMDS = [
  { label: '📊 Dashboard', prompt: 'Donne-moi un résumé exécutif complet de la plateforme avec KPIs, alertes et recommandations prioritaires' },
  { label: '🚨 Signalements', prompt: 'Analyse tous les signalements en attente, identifie les patterns récurrents et recommande des actions concrètes par priorité' },
  { label: '📈 Croissance', prompt: 'Analyse la croissance de la plateforme sur les 30 derniers jours' },
  { label: '💰 Revenus', prompt: 'Analyse détaillée des revenus : MRR, commandes, tips, commissions' },
  { label: '🔒 Audit Sécurité', prompt: 'Lance un audit sécurité complet' },
  { label: '🛍️ Marketplace', prompt: 'Analyse la marketplace : produits, vendeurs, catégories populaires' },
  { label: '🧬 Optimiser Algo', prompt: "Analyse les métriques d'engagement et propose des optimisations" },
  { label: '💡 Stratégie', prompt: "Propose un plan d'action stratégique pour les 30 prochains jours" },
];

const WELCOME_MSG: ZMsg = { role: 'system', content: `⚡ **Zeus v2** — Assistant Stratégique Proactif\n\nPropulsé par **Gemini 3.1 Pro** avec accès temps réel à vos données.\n\n💡 Commencez par me demander un dashboard ou dites "Quoi de neuf ?"` };

export function ZeusSection() {
  const ZEUS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zeus`;
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ZMsg[]>([WELCOME_MSG]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingProposals, setPendingProposals] = useState<Map<string, { action: string; key: string; updates: any; reason: string }>>(new Map());
  const [appliedProposals, setAppliedProposals] = useState<Set<string>>(new Set());
  const [rejectedProposals, setRejectedProposals] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversationIdRef = useRef<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatHistory = useRef<{ role: string; content: string }[]>([]);

  // Fetch conversation list
  const { data: conversations = [], refetch: refetchConvs } = useQuery({
    queryKey: ['zeus-conversations'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];
      const { data } = await supabase.from('zeus_conversations')
        .select('id, title, updated_at, messages')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(50);
      return (data || []) as ZConv[];
    },
  });

  // Load most recent conversation on mount
  useEffect(() => {
    if (conversations.length > 0 && !conversationIdRef.current) {
      const latest = conversations[0];
      if (latest.messages && Array.isArray(latest.messages) && latest.messages.length > 1) {
        conversationIdRef.current = latest.id;
        setMessages(latest.messages as ZMsg[]);
        chatHistory.current = (latest.messages as ZMsg[]).filter((m: ZMsg) => m.role === 'user' || m.role === 'assistant');
      }
    }
  }, [conversations]);

  const saveConversation = useCallback(async (msgs: ZMsg[]) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || msgs.length <= 1) return;
      const title = msgs.find(m => m.role === 'user')?.content.slice(0, 80) || 'Conversation Zeus';
      if (conversationIdRef.current) {
        await supabase.from('zeus_conversations').update({ messages: msgs as any, title, updated_at: new Date().toISOString() }).eq('id', conversationIdRef.current);
      } else {
        const { data } = await supabase.from('zeus_conversations').insert({ user_id: user.id, messages: msgs as any, title }).select('id').single();
        if (data) conversationIdRef.current = data.id;
      }
      refetchConvs();
    }, 1500);
  }, [refetchConvs]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  const isInitialLoad = useRef(true);
  useEffect(() => {
    if (isInitialLoad.current) { isInitialLoad.current = false; return; }
    if (messages.length > 1) saveConversation(messages);
  }, [messages, saveConversation]);

  // Switch to a conversation
  const loadConversation = useCallback((conv: ZConv) => {
    conversationIdRef.current = conv.id;
    const msgs = (conv.messages || []) as ZMsg[];
    setMessages(msgs.length > 0 ? msgs : [WELCOME_MSG]);
    chatHistory.current = msgs.filter(m => m.role === 'user' || m.role === 'assistant');
    setPendingProposals(new Map());
    setAppliedProposals(new Set());
    setRejectedProposals(new Set());
    setSidebarOpen(false);
  }, []);

  // New conversation
  const newConversation = useCallback(() => {
    conversationIdRef.current = null;
    chatHistory.current = [];
    isInitialLoad.current = true;
    setMessages([WELCOME_MSG]);
    setPendingProposals(new Map());
    setAppliedProposals(new Set());
    setRejectedProposals(new Set());
    setSidebarOpen(false);
  }, []);

  // Delete a conversation
  const deleteConversation = useCallback(async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await supabase.from('zeus_conversations').delete().eq('id', convId);
    if (conversationIdRef.current === convId) {
      newConversation();
    }
    refetchConvs();
    toast({ title: 'Conversation supprimée' });
  }, [newConversation, refetchConvs]);

  // Delete ALL conversations
  const deleteAllConversations = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('zeus_conversations').delete().eq('user_id', user.id);
    newConversation();
    refetchConvs();
    toast({ title: 'Toutes les conversations supprimées' });
  }, [newConversation, refetchConvs]);

  const parseProposals = useCallback((content: string) => {
    const regex = /\[ZEUS_PROPOSAL\]\s*\n([\s\S]*?)\[\/ZEUS_PROPOSAL\]/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const block = match[1];
      const actionMatch = block.match(/action:\s*(.+)/);
      const keyMatch = block.match(/key:\s*(.+)/);
      const updatesMatch = block.match(/updates:\s*({[\s\S]*?})/);
      const reasonMatch = block.match(/reason:\s*(.+)/);
      if (actionMatch && keyMatch && updatesMatch && reasonMatch) {
        const id = `${keyMatch[1].trim()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        try {
          const updates = JSON.parse(updatesMatch[1].trim());
          setPendingProposals(prev => { const next = new Map(prev); next.set(id, { action: actionMatch[1].trim().split('|')[0].replace(/[`\s]/g, '').replace(/\.$/, ''), key: keyMatch[1].trim(), updates, reason: reasonMatch[1].trim() }); return next; });
        } catch {}
      }
    }
  }, []);

  const applyProposal = useCallback(async (proposalId: string) => {
    const proposal = pendingProposals.get(proposalId);
    if (!proposal) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(ZEUS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }, body: JSON.stringify({ domain: 'admin', action: 'apply_proposal', proposalAction: proposal.action, key: proposal.key, updates: proposal.updates, reason: proposal.reason }) });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Erreur');
      await resp.json().catch(() => null);
      setAppliedProposals(prev => new Set(prev).add(proposalId));
      setMessages(prev => [...prev, { role: 'system', content: `✅ **Proposition appliquée** : ${proposal.reason}` }]);
      toast({ title: '✅ Proposition Zeus appliquée' });
    } catch (e: any) { toast({ title: 'Erreur', description: e.message, variant: 'destructive' }); }
  }, [pendingProposals]);

  const rejectProposal = useCallback((proposalId: string) => {
    setRejectedProposals(prev => new Set(prev).add(proposalId));
    const proposal = pendingProposals.get(proposalId);
    setMessages(prev => [...prev, { role: 'system', content: `❌ **Proposition refusée** : ${proposal?.reason || ''}` }]);
  }, [pendingProposals]);

  const renderContent = useCallback((content: string) => {
    const parts = content.split(/(\[ZEUS_PROPOSAL\][\s\S]*?\[\/ZEUS_PROPOSAL\])/g);
    return parts.map((part, i) => {
      const proposalMatch = part.match(/\[ZEUS_PROPOSAL\]\s*\n([\s\S]*?)\[\/ZEUS_PROPOSAL\]/);
      if (proposalMatch) {
        const block = proposalMatch[1];
        const key = block.match(/key:\s*(.+)/)?.[1]?.trim() || '';
        const reason = block.match(/reason:\s*(.+)/)?.[1]?.trim() || '';
        let updates: any = {};
        try { updates = JSON.parse(block.match(/updates:\s*({[\s\S]*?})/)?.[1]?.trim() || '{}'); } catch {}
        const proposalId = Array.from(pendingProposals.entries()).find(([, p]) => p.key === key && p.reason === reason)?.[0];
        const isApplied = proposalId ? appliedProposals.has(proposalId) : false;
        const isRejected = proposalId ? rejectedProposals.has(proposalId) : false;
        return (
          <div key={i} className="my-3 rounded-xl border-2 border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 mb-2"><Zap className="w-4 h-4 text-amber-400" /><span className="text-xs font-bold text-amber-400 uppercase">Proposition Zeus</span></div>
            <p className="text-sm font-medium mb-1">{reason}</p>
            <div className="text-xs text-muted-foreground mb-2"><span className="font-mono bg-muted/50 px-1.5 py-0.5 rounded">{key}</span> → <span className="font-mono">{JSON.stringify(updates)}</span></div>
            {isApplied ? <Badge className="bg-green-500/20 text-green-400 border-green-500/30">✅ Appliquée</Badge>
              : isRejected ? <Badge variant="outline" className="text-red-400 border-red-500/30">❌ Refusée</Badge>
              : proposalId ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => applyProposal(proposalId)} className="gap-1 bg-green-600 hover:bg-green-700 text-white text-xs h-7">✅ Valider</Button>
                  <Button size="sm" variant="outline" onClick={() => rejectProposal(proposalId)} className="gap-1 text-xs h-7 border-red-500/30 text-red-400 hover:bg-red-500/10">❌ Refuser</Button>
                </div>
              ) : null}
          </div>
        );
      }
      return <SafeMarkdown key={i}>{part}</SafeMarkdown>;
    });
  }, [pendingProposals, appliedProposals, rejectedProposals, applyProposal, rejectProposal]);

  const streamSSE = async (resp: Response, prefix = '') => {
    let content = ''; const reader = resp.body!.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) { const { done, value } = await reader.read(); if (done) break; buf += decoder.decode(value, { stream: true }); let idx;
      while ((idx = buf.indexOf('\n')) !== -1) { let line = buf.slice(0, idx); buf = buf.slice(idx + 1); if (line.endsWith('\r')) line = line.slice(0, -1); if (!line.startsWith('data: ')) continue; const j = line.slice(6).trim(); if (j === '[DONE]') break;
        try { const c = JSON.parse(j).choices?.[0]?.delta?.content; if (c) { content += c; setMessages(p => { const last = p[p.length - 1]; if (last?.role === 'assistant') return p.map((m, i) => i === p.length - 1 ? { ...m, content: prefix + content } : m); return [...p, { role: 'assistant' as const, content: prefix + content }]; }); } } catch {} } }
    parseProposals(content);
    return content;
  };

  const send = useCallback(async () => {
    const text = input.trim(); if (!text || streaming) return;
    setInput(''); setMessages(p => [...p, { role: 'user', content: text }]); setStreaming(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` };
      chatHistory.current.push({ role: 'user', content: text });
      const resp = await fetch(ZEUS_URL, { method: 'POST', headers, body: JSON.stringify({ domain: 'admin', action: 'chat', messages: chatHistory.current }) });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Erreur');
      const assistantContent = await streamSSE(resp);
      chatHistory.current.push({ role: 'assistant', content: assistantContent });
    } catch (e: any) { setMessages(p => [...p, { role: 'assistant', content: `### ❌ Erreur\n\n${e.message}` }]); }
    finally { setStreaming(false); }
  }, [input, streaming, parseProposals]);

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-0">
      {/* Sidebar - Conversation list */}
      <div className={cn(
        "border-r border-border bg-card/50 flex flex-col shrink-0 transition-all duration-200",
        sidebarOpen ? "w-72" : "w-0 overflow-hidden border-r-0"
      )}>
        <div className="p-3 border-b border-border flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Conversations</span>
          <div className="flex gap-1">
            {conversations.length > 0 && (
              <Button size="sm" variant="ghost" className="h-7 text-[10px] text-destructive hover:text-destructive" onClick={deleteAllConversations}>
                Tout effacer
              </Button>
            )}
          </div>
        </div>
        <div className="p-2">
          <Button size="sm" variant="outline" className="w-full gap-2 text-xs h-8" onClick={newConversation}>
            <Plus className="w-3.5 h-3.5" /> Nouvelle conversation
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {conversations.map(conv => (
              <div
                key={conv.id}
                onClick={() => loadConversation(conv)}
                className={cn(
                  "group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-xs transition-colors",
                  conversationIdRef.current === conv.id
                    ? "bg-primary/10 text-foreground border border-primary/20"
                    : "hover:bg-muted/50 text-muted-foreground"
                )}
              >
                <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="truncate font-medium">{conv.title || 'Sans titre'}</p>
                  <p className="text-[10px] text-muted-foreground/60">
                    {new Date(conv.updated_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <Button
                  size="sm" variant="ghost"
                  className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive shrink-0"
                  onClick={(e) => deleteConversation(conv.id, e)}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
            {conversations.length === 0 && (
              <p className="text-[11px] text-muted-foreground/50 text-center py-4">Aucune conversation</p>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Main chat */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-3 mb-4 px-2">
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 shrink-0" onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}
          </Button>
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-primary/20 border border-amber-500/30 flex items-center justify-center"><Zap className="w-5 h-5 text-amber-400" /></div>
          <div><h2 className="text-lg font-bold text-foreground">Zeus — Assistant Stratégique</h2><p className="text-[11px] text-muted-foreground">Propose • Vous validez • Il applique</p></div>
          <Badge variant="outline" className="ml-auto text-[10px] border-amber-500/30 text-amber-400">PROACTIF</Badge>
          <Button size="sm" variant="ghost" className="text-xs text-muted-foreground h-7 gap-1" onClick={newConversation}>
            <Plus className="w-3 h-3" /> Nouvelle
          </Button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 mb-3 pr-1 px-2">
          {messages.map((msg, i) => (
            <div key={i} className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              {msg.role !== 'user' && <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500/20 to-primary/20 border border-amber-500/30 flex items-center justify-center shrink-0 mt-1"><Zap className="w-3.5 h-3.5 text-amber-400" /></div>}
              <div className={cn('max-w-[85%] rounded-2xl px-3 py-2.5 text-sm', msg.role === 'user' ? 'bg-primary text-primary-foreground rounded-br-md' : msg.role === 'system' ? 'bg-amber-500/5 border border-amber-500/20 rounded-bl-md' : 'bg-card border border-border rounded-bl-md')}>
                <div className="prose prose-sm max-w-none dark:prose-invert text-inherit">
                  {msg.role === 'assistant' ? renderContent(msg.content) : <SafeMarkdown>{msg.content}</SafeMarkdown>}
                </div>
              </div>
              {msg.role === 'user' && <div className="w-7 h-7 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0 mt-1"><Users className="w-3.5 h-3.5 text-primary" /></div>}
            </div>
          ))}
          {streaming && messages[messages.length - 1]?.role === 'user' && (
            <div className="flex gap-2"><div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500/20 to-primary/20 border border-amber-500/30 flex items-center justify-center shrink-0"><RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" /></div>
              <div className="bg-card border border-border rounded-2xl rounded-bl-md px-3 py-2.5"><div className="flex gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" /><span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} /><span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} /></div></div></div>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2 px-2">
          {QUICK_CMDS.map(c => (<button key={c.label} onClick={() => { setInput(c.prompt); inputRef.current?.focus(); }} className="px-3 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap bg-card border border-border hover:border-primary/40 text-muted-foreground hover:text-foreground transition-all">{c.label}</button>))}
        </div>

        <div className="flex gap-2 items-end mt-1 px-2">
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Commandez Zeus..." className="flex-1 min-h-[42px] max-h-[100px] resize-none text-sm rounded-xl border border-input bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring" rows={1} />
          <Button onClick={send} disabled={!input.trim() || streaming} className="h-[42px] w-[42px] shrink-0 bg-gradient-to-br from-amber-500 to-primary" size="icon">
            {streaming ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
