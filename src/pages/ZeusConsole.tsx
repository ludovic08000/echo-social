import { useState, useRef, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/AppLayout';
import { SEOHead } from '@/components/SEOHead';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import {
  Zap, Send, Loader2, Bot, User, Terminal, Activity,
  Shield, FileText, ShoppingBag, Image, MessageSquare,
  Trash2, Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type Message = { role: 'user' | 'assistant' | 'system'; content: string };

const ZEUS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zeus`;

const QUICK_COMMANDS = [
  { label: '🛡️ Modérer un texte', prompt: 'Modère ce message : "Salut, tu veux gagner 1000€ ? Clique ici vite !"' },
  { label: '✍️ Améliorer un post', prompt: 'Améliore ce post : "hey les gars jsui trop content de vs annoncer que je lance mon projet"' },
  { label: '📊 Analyser sentiment', prompt: 'Analyse le sentiment de : "Cette plateforme est absolument incroyable, je suis tellement reconnaissant"' },
  { label: '🌍 Traduire', prompt: 'Traduis en anglais : "Bonjour, bienvenue sur notre réseau social innovant"' },
  { label: '📝 Générer description produit', prompt: 'Génère une description pour un produit : Sneakers Nike Air Max 90, taille 42, blanches, neuves' },
  { label: '🔍 Status Zeus', prompt: '/status' },
];

export default function ZeusConsole() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'system',
      content: `⚡ **Console Zeus** — Moteur IA Central ForSure

Bienvenue dans la console de pilotage. Vous pouvez :
- **Modérer** du contenu → \`domain: moderation\`
- **Améliorer** des posts → \`domain: post\`
- **Traduire / Résumer / Corriger** → \`domain: content\`
- **Coach vendeur** → \`domain: seller\`
- **Assistant pub** → \`domain: ads\`
- **Analyser photos** → \`domain: photo\`

Tapez une commande ou utilisez les raccourcis ci-dessous.`,
    },
  ]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const inferDomainAction = (text: string): { domain: string; action: string; extra: Record<string, any> } => {
    const lower = text.toLowerCase();

    if (lower.startsWith('/status')) {
      return { domain: '_status', action: 'status', extra: {} };
    }

    // Moderation
    if (lower.includes('modèr') || lower.includes('moder') || lower.includes('toxic') || lower.includes('spam')) {
      const match = text.match(/[«"""](.+?)[»"""]|:\s*[«"""]?(.+)/);
      const messageBody = match?.[1] || match?.[2] || text;
      return { domain: 'moderation', action: 'moderate_message', extra: { messageBody } };
    }

    // Post improvement
    if (lower.includes('amélio') || lower.includes('ameli') || lower.includes('post') || lower.includes('réécri')) {
      const match = text.match(/[«"""](.+?)[»"""]|:\s*[«"""]?(.+)/);
      const postText = match?.[1] || match?.[2] || text;
      let action = 'improve';
      if (lower.includes('formel') || lower.includes('pro')) action = 'formal';
      if (lower.includes('casual') || lower.includes('décontract')) action = 'casual';
      if (lower.includes('court') || lower.includes('raccour')) action = 'shorter';
      if (lower.includes('long') || lower.includes('développ')) action = 'longer';
      return { domain: 'post', action, extra: { text: postText } };
    }

    // Translation
    if (lower.includes('tradui') || lower.includes('translat')) {
      const match = text.match(/[«"""](.+?)[»"""]|:\s*[«"""]?(.+)/);
      const t = match?.[1] || match?.[2] || text;
      let targetLanguage = 'en';
      if (lower.includes('français') || lower.includes('french')) targetLanguage = 'fr';
      if (lower.includes('espagnol') || lower.includes('spanish')) targetLanguage = 'es';
      if (lower.includes('allemand') || lower.includes('german')) targetLanguage = 'de';
      if (lower.includes('anglais') || lower.includes('english')) targetLanguage = 'en';
      return { domain: 'content', action: 'translate', extra: { text: t, targetLanguage } };
    }

    // Summarize
    if (lower.includes('résum') || lower.includes('summar')) {
      const match = text.match(/[«"""](.+?)[»"""]|:\s*[«"""]?(.+)/);
      return { domain: 'content', action: 'summarize', extra: { text: match?.[1] || match?.[2] || text } };
    }

    // Correct
    if (lower.includes('corrig') || lower.includes('orthograph') || lower.includes('correct')) {
      const match = text.match(/[«"""](.+?)[»"""]|:\s*[«"""]?(.+)/);
      return { domain: 'content', action: 'correct', extra: { text: match?.[1] || match?.[2] || text } };
    }

    // Seller / product description
    if (lower.includes('description') || lower.includes('produit') || lower.includes('product')) {
      const match = text.match(/[«"""](.+?)[»"""]|:\s*[«"""]?(.+)/);
      return { domain: 'seller', action: 'generate_description', extra: { productInfo: match?.[1] || match?.[2] || text } };
    }

    // Sentiment
    if (lower.includes('sentiment') || lower.includes('émotion') || lower.includes('emotion') || lower.includes('analyse')) {
      const match = text.match(/[«"""](.+?)[»"""]|:\s*[«"""]?(.+)/);
      return { domain: 'content', action: 'summarize', extra: { text: match?.[1] || match?.[2] || text } };
    }

    // Default: content improve
    return { domain: 'content', action: 'improve', extra: { text, tone: 'friendly' } };
  };

  const formatResult = (domain: string, action: string, data: any): string => {
    if (domain === '_status') return data;

    if (domain === 'moderation' && action === 'moderate_message') {
      const safe = data.safe;
      return `### 🛡️ Résultat de Modération

| Critère | Valeur |
|---------|--------|
| **Statut** | ${safe ? '✅ Sûr' : '⚠️ Dangereux'} |
| **Catégorie** | ${data.category || 'safe'} |
| **Raison** | ${data.reason || 'Aucune'} |
${data.minorProtection ? '| **Protection mineur** | 🔒 Activée |' : ''}`;
    }

    if (domain === 'post') {
      return `### ✍️ Post Amélioré

${data.improved_text || data.result || JSON.stringify(data)}

${data.corrections?.length ? `\n**Corrections :** ${data.corrections.join(', ')}` : ''}
${data.tone ? `**Ton :** ${data.tone}` : ''}
${data.detected_language ? `**Langue :** ${data.detected_language}` : ''}`;
    }

    if (domain === 'content') {
      return `### 📝 Résultat

${data.result || JSON.stringify(data)}`;
    }

    // Generic
    return `### ⚡ Réponse Zeus

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\``;
  };

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput('');
    const userMsg: Message = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setIsStreaming(true);

    try {
      const { domain, action, extra } = inferDomainAction(text);

      // Status command
      if (domain === '_status') {
        const domains = ['content', 'post', 'moderation', 'ads', 'seller', 'photo', 'agent'];
        const statusMsg = `### ⚡ Zeus Status

| Domaine | Actions |
|---------|---------|
| **content** | summarize, translate, correct, improve |
| **post** | improve, formal, casual, shorter, longer |
| **moderation** | moderate_message, accept_request, reject_request |
| **ads** | chat, generate_ad, moderate_ad, generate_image |
| **seller** | generate_description, coach_chat |
| **photo** | analyze_photo, compare_photos |
| **agent** | chat with AI agents |

🟢 **Tous les systèmes sont opérationnels**
🧠 **Modèle** : Gemini 3 Flash Preview
🔒 **Rate limiting** : Actif par domaine`;

        setMessages(prev => [...prev, { role: 'assistant', content: statusMsg }]);
        setIsStreaming(false);
        return;
      }

      // For streaming domains (seller generate_description)
      if (domain === 'seller' && action === 'generate_description') {
        const { data: { session } } = await supabase.auth.getSession();
        const resp = await fetch(ZEUS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({ domain, action, ...extra }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: 'Erreur Zeus' }));
          throw new Error(err.error || 'Erreur');
        }

        if (resp.headers.get('content-type')?.includes('text/event-stream')) {
          let assistantContent = '';
          const reader = resp.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
              let line = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 1);
              if (line.endsWith('\r')) line = line.slice(0, -1);
              if (!line.startsWith('data: ') || line.trim() === '') continue;
              const jsonStr = line.slice(6).trim();
              if (jsonStr === '[DONE]') break;
              try {
                const parsed = JSON.parse(jsonStr);
                const c = parsed.choices?.[0]?.delta?.content;
                if (c) {
                  assistantContent += c;
                  setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.role === 'assistant') return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: `### 📝 Description Générée\n\n${assistantContent}` } : m);
                    return [...prev, { role: 'assistant', content: `### 📝 Description Générée\n\n${assistantContent}` }];
                  });
                }
              } catch {}
            }
          }
          setIsStreaming(false);
          return;
        }

        const data = await resp.json();
        setMessages(prev => [...prev, { role: 'assistant', content: formatResult(domain, action, data) }]);
        setIsStreaming(false);
        return;
      }

      // Non-streaming calls
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(ZEUS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({ domain, action, ...extra }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Erreur Zeus' }));
        throw new Error(err.error || `Erreur ${resp.status}`);
      }

      const data = await resp.json();
      setMessages(prev => [...prev, { role: 'assistant', content: formatResult(domain, action, data) }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `### ❌ Erreur\n\n${err.message}` }]);
      toast.error(err.message);
    } finally {
      setIsStreaming(false);
    }
  }, [input, isStreaming]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages(prev => [prev[0]]);
  };

  return (
    <AppLayout>
      <SEOHead title="Console Zeus — ForSure" description="Pilotez le moteur IA central Zeus" />

      <div className="max-w-3xl mx-auto px-4 py-4 pb-24 md:pb-8 h-[calc(100vh-80px)] flex flex-col">
        {/* Header */}
        <header className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-primary/20 border border-amber-500/30 flex items-center justify-center">
              <Zap className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground flex items-center gap-2">
                Console Zeus
                <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">LIVE</Badge>
              </h1>
              <p className="text-[11px] text-muted-foreground">Moteur IA central • 7 domaines • Gemini 3 Flash</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={clearChat} className="text-muted-foreground">
            <Trash2 className="w-4 h-4" />
          </Button>
        </header>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 mb-4 pr-1">
          {messages.map((msg, i) => (
            <div key={i} className={cn('flex gap-3', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              {msg.role !== 'user' && (
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500/20 to-primary/20 border border-amber-500/30 flex items-center justify-center shrink-0 mt-1">
                  {msg.role === 'system' ? <Terminal className="w-4 h-4 text-amber-400" /> : <Bot className="w-4 h-4 text-primary" />}
                </div>
              )}
              <div className={cn(
                'max-w-[85%] rounded-2xl px-4 py-3 text-sm',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-br-md'
                  : 'bg-card border border-border rounded-bl-md'
              )}>
                <div className="prose prose-sm max-w-none dark:prose-invert text-inherit">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              </div>
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0 mt-1">
                  <User className="w-4 h-4 text-primary" />
                </div>
              )}
            </div>
          ))}
          {isStreaming && messages[messages.length - 1]?.role === 'user' && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500/20 to-primary/20 border border-amber-500/30 flex items-center justify-center shrink-0">
                <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
              </div>
              <div className="bg-card border border-border rounded-2xl rounded-bl-md px-4 py-3">
                <div className="flex gap-1">
                  <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Quick commands */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2">
          {QUICK_COMMANDS.map((cmd) => (
            <button
              key={cmd.label}
              onClick={() => { setInput(cmd.prompt); textareaRef.current?.focus(); }}
              className="px-3 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap bg-card border border-border hover:border-primary/40 text-muted-foreground hover:text-foreground transition-all"
            >
              {cmd.label}
            </button>
          ))}
        </div>

        {/* Input */}
        <div className="flex gap-2 items-end mt-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Commandez Zeus... (ex: modère 'texte', traduis en anglais, améliore ce post...)"
            className="min-h-[44px] max-h-[120px] resize-none text-sm"
            rows={1}
          />
          <Button
            onClick={sendMessage}
            disabled={!input.trim() || isStreaming}
            className="h-11 w-11 shrink-0 bg-gradient-to-br from-amber-500 to-primary hover:from-amber-600 hover:to-primary/90"
            size="icon"
          >
            {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </AppLayout>
  );
}
