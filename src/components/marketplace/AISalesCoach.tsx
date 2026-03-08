import { useState, useRef, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Bot, Send, Loader2, TrendingUp } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

type Message = { role: 'user' | 'assistant'; content: string };

interface AISalesCoachProps {
  sellerName: string;
  totalSales: number;
  totalRevenue: number;
  productCount: number;
  orderCount: number;
  products?: { title: string; price: number; category: string; stock: number | null; created: string }[];
  recentOrders?: { total: number; status: string; date: string; items: number }[];
  rating?: number;
  ratingCount?: number;
}

export function AISalesCoach({
  sellerName, totalSales, totalRevenue, productCount, orderCount,
  products = [], recentOrders = [], rating, ratingCount = 0,
}: AISalesCoachProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [autoAnalysisDone, setAutoAnalysisDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const context = {
    sellerName,
    totalSales,
    totalRevenue,
    productCount,
    orderCount,
    products: products.slice(0, 15),
    recentOrders: recentOrders.slice(0, 20),
    rating,
    ratingCount,
    averageOrderValue: orderCount > 0 ? Math.round(totalRevenue / orderCount * 100) / 100 : 0,
  };

  const quickPrompts = [
    '📊 Analyse complète de ma boutique',
    '🏷️ Compare mes prix à la concurrence',
    '📈 Comment augmenter mes ventes ?',
    '🔥 Quelles catégories se vendent le mieux ?',
    '🎯 Donne-moi un plan d\'action chiffré',
    '⚡ Score de performance de ma boutique',
  ];

  const sendMessage = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMsg: Message = { role: 'user', content: text.trim() };
    const allMessages = [...messages, userMsg];
    setMessages(allMessages);
    setInput('');
    setIsLoading(true);

    let assistantContent = '';

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/seller-ai-coach`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            action: 'coach_chat',
            messages: allMessages,
            context,
          }),
        }
      );

      if (!response.ok) {
        if (response.status === 429) throw new Error('Trop de requêtes, réessayez dans un moment');
        if (response.status === 402) throw new Error('Crédits IA épuisés');
        throw new Error('Erreur IA');
      }

      if (!response.body) throw new Error('Pas de réponse');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantContent += content;
              setMessages((prev) => {
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
      setMessages((prev) => [...prev, { role: 'assistant', content: `❌ ${e.message}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const runAutoAnalysis = () => {
    setAutoAnalysisDone(true);
    sendMessage('Fais une analyse complète de ma boutique avec mes chiffres de ventes, identifie les points forts et faibles, et donne-moi 5 recommandations concrètes pour augmenter mon chiffre d\'affaires.');
  };

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" />
            <h4 className="text-sm font-bold">Coach IA Ventes</h4>
          </div>
          {messages.length === 0 && !autoAnalysisDone && (
            <Button size="sm" className="h-7 text-xs gap-1" onClick={runAutoAnalysis}>
              <TrendingUp className="w-3 h-3" /> Analyser ma boutique
            </Button>
          )}
        </div>

        {/* Stats summary */}
        {messages.length === 0 && !isLoading && (
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'Ventes', value: totalSales },
              { label: 'CA', value: `${totalRevenue.toFixed(0)}€` },
              { label: 'Produits', value: productCount },
              { label: 'Note', value: rating ? `${rating.toFixed(1)}⭐` : '—' },
            ].map((s) => (
              <div key={s.label} className="rounded-lg bg-secondary/50 p-2 text-center">
                <p className="text-[10px] text-muted-foreground">{s.label}</p>
                <p className="text-sm font-bold">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {messages.length === 0 && !isLoading ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Le coach analyse vos données réelles (ventes, produits, commandes, notes) et vous donne des recommandations personnalisées.
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {quickPrompts.map((prompt) => (
                <Button
                  key={prompt}
                  variant="outline"
                  size="sm"
                  className="h-auto py-2 px-2.5 text-[10px] text-left leading-tight whitespace-normal"
                  onClick={() => sendMessage(prompt)}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <ScrollArea className="h-72">
            <div className="space-y-3 pr-2">
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-xl px-3 py-2 text-xs ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary border border-border'
                  }`}>
                    {msg.role === 'assistant' ? (
                      <div className="prose prose-sm max-w-none text-xs">
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                      </div>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
              ))}
              {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="flex justify-start">
                  <div className="bg-secondary border border-border rounded-xl px-3 py-2">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                  </div>
                </div>
              )}
              <div ref={scrollRef} />
            </div>
          </ScrollArea>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage(input);
          }}
        >
          <Input
            placeholder="Posez votre question..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="text-xs h-9"
            disabled={isLoading}
          />
          <Button type="submit" size="icon" className="h-9 w-9 flex-shrink-0" disabled={isLoading || !input.trim()}>
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
