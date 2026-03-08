import { useState, useRef, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Bot, Send, Loader2, TrendingUp, Camera, PenLine, Search, AlertTriangle, Zap } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

type Message = { role: 'user' | 'assistant'; content: string };

interface ProductData {
  title: string;
  price: number;
  category: string;
  stock: number | null;
  created: string;
  description?: string;
  thumbnail?: string;
  images?: string[];
  productType?: string;
}

interface AISalesCoachProps {
  sellerName: string;
  totalSales: number;
  totalRevenue: number;
  productCount: number;
  orderCount: number;
  products?: ProductData[];
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
    products: products.slice(0, 15).map(p => ({
      ...p,
      photoCount: (p.images?.length || 0) + (p.thumbnail ? 1 : 0),
      hasDescription: !!p.description && p.description.length > 20,
      descriptionLength: p.description?.length || 0,
      descriptionQuality: !p.description ? 'absente' : p.description.length < 50 ? 'faible' : p.description.length < 150 ? 'correcte' : 'détaillée',
      imageUrls: [p.thumbnail, ...(p.images || [])].filter(Boolean).slice(0, 3),
    })),
    recentOrders: recentOrders.slice(0, 20),
    rating,
    ratingCount,
    averageOrderValue: orderCount > 0 ? Math.round(totalRevenue / orderCount * 100) / 100 : 0,
  };

  const quickActions = [
    { icon: TrendingUp, label: '📊 Analyse complète', prompt: 'Fais une analyse complète de ma boutique : score /100, prix vs concurrence, probabilité de vente de chaque produit, et plan d\'action chiffré.' },
    { icon: Search, label: '🏷️ Comparer mes prix', prompt: 'Compare chacun de mes produits aux prix du marché. Pour chaque produit, donne : prix médian marché, écart en %, positionnement (trop cher/correct/sous-évalué), et prix optimal recommandé.' },
    { icon: Camera, label: '📸 Analyser mes photos', prompt: 'Analyse les photos de mes produits. Pour chaque annonce, évalue : nombre de photos, qualité estimée, et donne des conseils concrets pour améliorer l\'attractivité visuelle.' },
    { icon: AlertTriangle, label: '💎 Produits sous-évalués', prompt: 'Détecte les annonces sous-évaluées dans ma boutique ET sur la marketplace. Quels produits sont vendus bien en dessous du prix marché ? Opportunités d\'arbitrage ?' },
    { icon: PenLine, label: '✍️ Réécrire mes annonces', prompt: 'Réécris automatiquement les titres et descriptions de TOUS mes produits pour maximiser les ventes. Pour chaque produit, donne : ancien titre → nouveau titre optimisé, et une description SEO complète.' },
    { icon: Zap, label: '⚡ Estimation demande', prompt: 'Estime la demande réelle pour chacun de mes produits en te basant sur le volume de ventes de la catégorie, le nombre de concurrents et les tendances. Classe-les par potentiel de vente.' },
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
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zeus`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            domain: 'seller',
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
    sendMessage('Fais une analyse complète de ma boutique : détecte automatiquement le type de chaque produit à partir du titre, analyse les photos, compare les prix au marché, estime la demande, et donne un score /100 avec plan d\'action chiffré pour augmenter le CA.');
  };

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" />
            <div>
              <h4 className="text-sm font-bold">Coach IA Ventes</h4>
              <p className="text-[10px] text-muted-foreground">Analyse marché • Pricing • Optimisation</p>
            </div>
          </div>
          {messages.length === 0 && !autoAnalysisDone && (
            <Button size="sm" className="h-8 text-xs gap-1.5" onClick={runAutoAnalysis}>
              <TrendingUp className="w-3.5 h-3.5" /> Analyse auto
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
              IA avancée : analyse photos, détection sous-évaluation, réécriture d'annonces, estimation demande et pricing dynamique.
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {quickActions.map((qa) => (
                <Button
                  key={qa.label}
                  variant="outline"
                  size="sm"
                  className="h-auto py-2 px-2.5 text-[10px] text-left leading-tight whitespace-normal"
                  onClick={() => sendMessage(qa.prompt)}
                >
                  {qa.label}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <ScrollArea className="h-80">
            <div className="space-y-3 pr-2">
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[90%] rounded-xl px-3 py-2 text-xs ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary border border-border'
                  }`}>
                    {msg.role === 'assistant' ? (
                      <div className="prose prose-sm max-w-none text-xs [&_table]:text-[10px] [&_th]:px-1.5 [&_td]:px-1.5">
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
                  <div className="bg-secondary border border-border rounded-xl px-3 py-2 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    <span className="text-[10px] text-muted-foreground">Analyse en cours...</span>
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
            placeholder="Posez votre question au coach IA..."
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
