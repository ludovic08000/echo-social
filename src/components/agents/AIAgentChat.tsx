import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Send, Loader2, Crown, User, Zap, RotateCcw, Check, X, Calendar, Image, FileText, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { useAuth } from '@/lib/auth';
import { useAIAgentUsage, type AIAgent } from '@/hooks/useAIAgents';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { SafeMarkdown } from '@/components/SafeMarkdown';

interface Props {
  agent: AIAgent;
  onBack: () => void;
}

interface ActionBlock {
  type: 'publish_post' | 'schedule_post' | 'create_story' | 'generate_image';
  body?: string;
  caption?: string;
  publish_at?: string;
  image_prompt?: string | null;
  prompt?: string;
}

type Msg = { role: string; content: string; id?: string; action?: ActionBlock; actionStatus?: 'pending' | 'executing' | 'done' | 'cancelled'; actionResult?: any };

function parseActionFromContent(content: string): { text: string; action: ActionBlock | null } {
  const regex = /```forsure-action\s*\n([\s\S]*?)\n```/;
  const match = content.match(regex);
  if (!match) return { text: content, action: null };

  try {
    const action = JSON.parse(match[1]) as ActionBlock;
    const text = content.replace(regex, '').trim();
    return { text, action };
  } catch {
    return { text: content, action: null };
  }
}

const actionLabels: Record<string, { icon: typeof FileText; label: string; color: string }> = {
  publish_post: { icon: FileText, label: 'Publier un post', color: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20' },
  schedule_post: { icon: Calendar, label: 'Programmer un post', color: 'text-blue-600 bg-blue-500/10 border-blue-500/20' },
  create_story: { icon: Sparkles, label: 'Créer une story', color: 'text-purple-600 bg-purple-500/10 border-purple-500/20' },
  generate_image: { icon: Image, label: 'Générer une image', color: 'text-amber-600 bg-amber-500/10 border-amber-500/20' },
};

function ActionPreviewCard({ action, status, result, onConfirm, onCancel }: {
  action: ActionBlock;
  status: 'pending' | 'executing' | 'done' | 'cancelled';
  result?: any;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const config = actionLabels[action.type] || actionLabels.publish_post;
  const Icon = config.icon;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn('rounded-xl border p-3 mt-2 space-y-2', config.color)}
    >
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4" />
        <span className="text-xs font-semibold">{config.label}</span>
        {status === 'done' && <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 bg-emerald-500/20 text-emerald-700">✓ Exécuté</Badge>}
        {status === 'cancelled' && <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 bg-muted text-muted-foreground">Annulé</Badge>}
        {status === 'executing' && <Loader2 className="w-3 h-3 animate-spin" />}
      </div>

      {/* Preview content */}
      <div className="bg-background/60 rounded-lg p-2.5 text-xs space-y-1">
        {action.body && (
          <p className="text-foreground leading-relaxed">{action.body}</p>
        )}
        {action.caption && (
          <p className="text-foreground leading-relaxed">📝 {action.caption}</p>
        )}
        {action.publish_at && (
          <p className="text-muted-foreground flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            {new Date(action.publish_at).toLocaleDateString('fr-FR', { dateStyle: 'full' })} à {new Date(action.publish_at).toLocaleTimeString('fr-FR', { timeStyle: 'short' })}
          </p>
        )}
        {(action.image_prompt || action.prompt) && (
          <p className="text-muted-foreground flex items-center gap-1">
            <Image className="w-3 h-3" /> Image : {action.image_prompt || action.prompt}
          </p>
        )}
      </div>

      {/* Result image */}
      {result?.image_url && (
        <div className="rounded-lg overflow-hidden">
          <img src={result.image_url} alt="Generated" className="w-full max-h-48 object-cover rounded-lg" />
        </div>
      )}
      {result?.message && status === 'done' && (
        <p className="text-xs font-medium text-foreground">{result.message}</p>
      )}

      {/* Action buttons */}
      {status === 'pending' && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={onConfirm} className="h-7 text-xs gap-1 rounded-lg flex-1">
            <Check className="w-3 h-3" /> Confirmer
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel} className="h-7 text-xs gap-1 rounded-lg">
            <X className="w-3 h-3" /> Annuler
          </Button>
        </div>
      )}
    </motion.div>
  );
}

export function AIAgentChat({ agent, onBack }: Props) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: usage } = useAIAgentUsage(agent.id);
  const remaining = agent.free_messages_per_day - (usage?.message_count || 0);

  useEffect(() => {
    if (agent.welcome_message) {
      setMessages([{ role: 'assistant', content: agent.welcome_message }]);
    }
  }, [agent]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const executeAction = useCallback(async (msgIndex: number) => {
    const msg = messages[msgIndex];
    if (!msg?.action || !user) return;

    setMessages(prev => prev.map((m, i) => i === msgIndex ? { ...m, actionStatus: 'executing' } : m));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/agent-actions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ action: msg.action }),
      });

      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Erreur');

      setMessages(prev => prev.map((m, i) => i === msgIndex ? { ...m, actionStatus: 'done', actionResult: result } : m));
      toast({ title: '✅ Action exécutée', description: result.message });

      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      queryClient.invalidateQueries({ queryKey: ['stories'] });
    } catch (e: any) {
      toast({ title: 'Erreur', description: e.message, variant: 'destructive' });
      setMessages(prev => prev.map((m, i) => i === msgIndex ? { ...m, actionStatus: 'pending' } : m));
    }
  }, [messages, user, queryClient]);

  const cancelAction = useCallback((msgIndex: number) => {
    setMessages(prev => prev.map((m, i) => i === msgIndex ? { ...m, actionStatus: 'cancelled' } : m));
  }, []);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isStreaming || !user) return;

    const userMsg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsStreaming(true);

    try {
      const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zeus`;
      const { data: { session } } = await supabase.auth.getSession();

      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          domain: 'agent',
          action: 'agent_chat',
          agent_id: agent.id,
          conversation_id: conversationId,
          message: userMsg,
        }),
      });

      const newConvId = resp.headers.get('X-Conversation-Id');
      if (newConvId && !conversationId) setConversationId(newConvId);

      if (!resp.ok) {
        const err = await resp.json();
        if (err.error === 'limit_reached') {
          setMessages(prev => [
            ...prev.slice(0, -1),
            {
              role: 'assistant' as const,
              content: `⚡ **Tu as atteint ta limite de messages gratuits pour aujourd'hui !**\n\nPasse à l'abonnement **Créateur** (5€/mois) pour discuter sans limite, tous les jours. 🚀\n\n[👑 Devenir Créateur](/creator-upgrade)`,
            },
          ]);
          setIsStreaming(false);
          return;
        }
        throw new Error(err.error || 'Erreur serveur');
      }

      if (!resp.body) throw new Error('No stream');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let assistantSoFar = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line.startsWith('data: ') || line.trim() === '' || line.startsWith(':')) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') break;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantSoFar += content;
              const { text, action } = parseActionFromContent(assistantSoFar);
              setMessages(prev => {
                const last = prev[prev.length - 1];
                const newMsg: Msg = {
                  role: 'assistant',
                  content: assistantSoFar,
                  action: action || undefined,
                  actionStatus: action ? 'pending' : undefined,
                };
                if (last?.role === 'assistant' && !last.id) {
                  return prev.map((m, i) => i === prev.length - 1 ? newMsg : m);
                }
                return [...prev, newMsg];
              });
            }
          } catch {}
        }
      }

      queryClient.invalidateQueries({ queryKey: ['ai-agent-usage', agent.id] });
    } catch (e: any) {
      toast({ title: 'Erreur', description: e.message, variant: 'destructive' });
    } finally {
      setIsStreaming(false);
    }
  }, [input, isStreaming, user, agent, conversationId, queryClient]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const startNewConversation = () => {
    setConversationId(null);
    setMessages(agent.welcome_message ? [{ role: 'assistant', content: agent.welcome_message }] : []);
  };

  const renderMessageContent = (msg: Msg, index: number) => {
    if (msg.role === 'user') return <p className="whitespace-pre-wrap">{msg.content}</p>;

    const { text, action } = parseActionFromContent(msg.content);

    return (
      <div>
        {text && (
          <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:m-0 [&>ul]:mt-1 [&>ol]:mt-1">
            <SafeMarkdown>{text}</SafeMarkdown>
          </div>
        )}
        {msg.action && (
          <ActionPreviewCard
            action={msg.action}
            status={msg.actionStatus || 'pending'}
            result={msg.actionResult}
            onConfirm={() => executeAction(index)}
            onCancel={() => cancelAction(index)}
          />
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-[calc(100vh-120px)] md:h-[calc(100vh-80px)] max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 pb-3 border-b border-border/30 shrink-0">
        <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 rounded-xl">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-xl">
          {agent.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground truncate">{agent.name}</h2>
            {agent.is_premium && (
              <Badge variant="secondary" className="text-[9px] px-1 py-0 h-3.5 gap-0.5 bg-amber-500/15 text-amber-600 border-amber-500/20">
                <Crown className="w-2 h-2" /> Pro
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <Zap className="w-3 h-3 text-amber-500" />
            {remaining > 0 ? `${remaining} msg restants aujourd'hui` : 'Limite atteinte'}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={startNewConversation} className="h-8 w-8 rounded-xl" title="Nouvelle conversation">
          <RotateCcw className="w-4 h-4" />
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-4 space-y-3 min-h-0">
        <AnimatePresence initial={false}>
          {messages.map((msg, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              {msg.role === 'assistant' && (
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-sm shrink-0 mt-0.5">
                  {agent.icon}
                </div>
              )}
              <div className={cn(
                'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-br-md'
                  : 'bg-secondary/60 text-foreground rounded-bl-md border border-border/20'
              )}>
                {renderMessageContent(msg, i)}
              </div>
              {msg.role === 'user' && (
                <div className="w-7 h-7 rounded-lg bg-secondary/60 flex items-center justify-center shrink-0 mt-0.5">
                  <User className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        {isStreaming && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="flex gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-sm">{agent.icon}</div>
            <div className="bg-secondary/60 rounded-2xl rounded-bl-md px-4 py-3 border border-border/20">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 pt-2 border-t border-border/30">
        {remaining <= 0 ? (
          <div className="text-center py-4 space-y-2">
            <p className="text-sm text-muted-foreground">
              Vous avez atteint la limite de {agent.free_messages_per_day} messages/jour.
            </p>
            <p className="text-xs text-muted-foreground">Revenez demain pour continuer la conversation !</p>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ex: Publie un post motivant pour demain 14h..."
              className="flex-1 resize-none bg-secondary/30 border border-border/30 rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/30 transition-colors min-h-[42px] max-h-[120px]"
              rows={1}
              disabled={isStreaming}
            />
            <Button
              onClick={sendMessage}
              disabled={!input.trim() || isStreaming}
              size="icon"
              className="h-[42px] w-[42px] rounded-xl shrink-0"
            >
              {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
