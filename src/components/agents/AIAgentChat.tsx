import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Send, Loader2, Crown, Bot, User, Zap, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { useAuth } from '@/lib/auth';
import { useAIAgentMessages, useAIAgentUsage, type AIAgent } from '@/hooks/useAIAgents';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';

interface Props {
  agent: AIAgent;
  onBack: () => void;
}

type Msg = { role: string; content: string; id?: string };

export function AIAgentChat({ agent, onBack }: Props) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { data: usage } = useAIAgentUsage(agent.id);
  const remaining = agent.free_messages_per_day - (usage?.message_count || 0);

  // Init with welcome message
  useEffect(() => {
    if (agent.welcome_message) {
      setMessages([{ role: 'assistant', content: agent.welcome_message }]);
    }
  }, [agent]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isStreaming || !user) return;

    const userMsg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsStreaming(true);

    try {
      const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/agent-chat`;
      const { data: { session } } = await supabase.auth.getSession();

      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          agent_id: agent.id,
          conversation_id: conversationId,
          message: userMsg,
        }),
      });

      // Get conversation ID from header
      const newConvId = resp.headers.get('X-Conversation-Id');
      if (newConvId && !conversationId) setConversationId(newConvId);

      if (!resp.ok) {
        const err = await resp.json();
        if (err.error === 'limit_reached') {
          toast({ title: '⚡ Limite atteinte', description: err.message, variant: 'destructive' });
          setMessages(prev => prev.slice(0, -1)); // remove user msg
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
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && !last.id) {
                  return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantSoFar } : m);
                }
                return [...prev, { role: 'assistant', content: assistantSoFar }];
              });
            }
          } catch {}
        }
      }

      // Refresh usage
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
                {msg.role === 'assistant' ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:m-0 [&>ul]:mt-1 [&>ol]:mt-1">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                )}
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
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Écrivez votre message..."
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
