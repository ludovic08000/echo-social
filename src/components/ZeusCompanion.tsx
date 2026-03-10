import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, Loader2, Pencil, Check, Zap, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';
import { useZeusSettings, useZeusAgentId, useContentStrikes } from '@/hooks/useZeusCompanion';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import { toast } from 'sonner';

type Msg = { role: string; content: string };

// Parse action blocks from agent-chat
interface ActionBlock {
  type: 'publish_post' | 'schedule_post' | 'create_story' | 'generate_image';
  body?: string;
  caption?: string;
  publish_at?: string;
  image_prompt?: string | null;
  prompt?: string;
}

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

export function ZeusCompanion() {
  const { user } = useAuth();
  const { zeusName, updateName } = useZeusSettings();
  const { data: zeusAgentId } = useZeusAgentId();
  const { unacknowledged } = useContentStrikes();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  // Show strike warnings
  useEffect(() => {
    if (unacknowledged.length > 0 && !open) {
      const latest = unacknowledged[0] as any;
      toast.warning(latest.zeus_message || `${zeusName} a un message pour toi`, {
        duration: 8000,
        action: {
          label: 'Voir',
          onClick: () => setOpen(true),
        },
      });
    }
  }, [unacknowledged.length]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || !zeusAgentId || loading) return;
    const userMsg: Msg = { role: 'user', content: input.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const resp = await fetch(
        `https://${projectId}.supabase.co/functions/v1/agent-chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            agent_id: zeusAgentId,
            conversation_id: conversationId,
            message: userMsg.content,
          }),
        }
      );

      // Get conversation ID from header
      const convId = resp.headers.get('X-Conversation-Id');
      if (convId) setConversationId(convId);

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Erreur' }));
        throw new Error(err.message || err.error || 'Erreur');
      }

      // Stream response
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantContent += content;
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant') {
                  return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantContent } : m);
                }
                return [...prev, { role: 'assistant', content: assistantContent }];
              });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      toast.error(e.message || 'Erreur de communication avec Zeus');
    } finally {
      setLoading(false);
    }
  }, [input, zeusAgentId, conversationId, loading]);

  const handleRename = () => {
    if (newName.trim() && newName.trim().length <= 20) {
      updateName.mutate(newName.trim());
      setEditingName(false);
    }
  };

  if (!user) return null;

  return (
    <>
      {/* Floating button */}
      <AnimatePresence>
        {!open && (
          <motion.button
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            onClick={() => setOpen(true)}
            className="fixed bottom-20 right-4 z-50 w-14 h-14 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg flex items-center justify-center text-white hover:shadow-xl transition-shadow"
          >
            <Zap className="w-6 h-6" />
            {unacknowledged.length > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-destructive text-[10px] font-bold flex items-center justify-center text-white">
                {unacknowledged.length}
              </span>
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* Chat panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 100, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 100, scale: 0.9 }}
            className="fixed bottom-4 right-4 z-50 w-[360px] max-w-[calc(100vw-2rem)] h-[500px] max-h-[70vh] rounded-2xl border border-border/30 bg-card shadow-2xl flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/20 bg-gradient-to-r from-amber-500/10 to-orange-500/10">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-sm">⚡</div>
                {editingName ? (
                  <div className="flex items-center gap-1">
                    <Input
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      className="h-7 w-28 text-sm"
                      maxLength={20}
                      autoFocus
                      onKeyDown={e => e.key === 'Enter' && handleRename()}
                    />
                    <button onClick={handleRename} className="text-primary"><Check className="w-4 h-4" /></button>
                    <button onClick={() => setEditingName(false)} className="text-muted-foreground"><X className="w-4 h-4" /></button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-sm text-foreground">{zeusName}</span>
                    <button onClick={() => { setNewName(zeusName); setEditingName(true); }} className="text-muted-foreground hover:text-foreground">
                      <Pencil className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Strike warnings */}
            {unacknowledged.length > 0 && (
              <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {(unacknowledged[0] as any).zeus_message || 'Un de tes contenus a été signalé. Fais attention ! 🙏'}
                  </p>
                </div>
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
              {messages.length === 0 && (
                <div className="text-center py-8">
                  <div className="text-4xl mb-3">⚡</div>
                  <p className="text-sm text-muted-foreground">
                    Salut ! Je suis <strong>{zeusName}</strong>, ton compagnon IA.
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Parle-moi de tout, demande-moi de poster pour toi, ou simplement discutons ! 💬
                  </p>
                </div>
              )}
              {messages.map((msg, i) => {
                const { text, action } = msg.role === 'assistant' ? parseActionFromContent(msg.content) : { text: msg.content, action: null };
                return (
                  <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div className={cn(
                      'max-w-[85%] rounded-2xl px-3 py-2 text-sm',
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground rounded-br-md'
                        : 'bg-secondary/60 text-foreground rounded-bl-md'
                    )}>
                      {msg.role === 'assistant' ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <ReactMarkdown>{text}</ReactMarkdown>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap">{text}</p>
                      )}
                      {action && (
                        <div className="mt-2 p-2 rounded-lg bg-primary/10 border border-primary/20 text-xs">
                          <span className="font-semibold text-primary">📝 Action proposée</span>
                          <p className="mt-1 text-foreground">{action.body || action.caption || action.prompt}</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-secondary/60 rounded-2xl rounded-bl-md px-3 py-2">
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="px-3 py-3 border-t border-border/20">
              <form onSubmit={e => { e.preventDefault(); sendMessage(); }} className="flex gap-2">
                <Input
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder={`Parle à ${zeusName}...`}
                  className="flex-1 rounded-xl h-10 text-sm"
                  disabled={loading || !zeusAgentId}
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={!input.trim() || loading || !zeusAgentId}
                  className="h-10 w-10 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 hover:from-amber-500 hover:to-orange-600"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
