import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Sparkles, Loader2, Copy, Check } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { SafeMarkdown } from '@/components/SafeMarkdown';

interface AIProductHelperProps {
  productTitle?: string;
  productCategory?: string;
  productPrice?: number;
}

export function AIProductHelper({ productTitle, productCategory, productPrice }: AIProductHelperProps) {
  const [input, setInput] = useState(productTitle || '');
  const [result, setResult] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const generateDescription = async () => {
    if (!input.trim()) {
      toast.error('Décrivez brièvement votre produit');
      return;
    }
    setIsLoading(true);
    setResult('');

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
            action: 'generate_description',
            productInfo: input.trim(),
            category: productCategory,
            price: productPrice,
          }),
        }
      );

      if (!response.ok) throw new Error('Erreur IA');
      if (!response.body) throw new Error('Pas de réponse');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
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
          if (!line.startsWith('data: ') || line.trim() === '') continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) setResult((prev) => prev + content);
          } catch {}
        }
      }
    } catch (e: any) {
      toast.error(e.message || 'Erreur lors de la génération');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(result);
    setCopied(true);
    toast.success('Description copiée !');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h4 className="text-sm font-bold">IA — Générateur de description</h4>
        </div>

        <Textarea
          placeholder="Décrivez brièvement votre produit (ex: chemise en lin blanche, taille M, fabriquée en France)..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          className="text-xs"
        />

        <Button
          size="sm"
          className="w-full"
          onClick={generateDescription}
          disabled={isLoading || !input.trim()}
        >
          {isLoading ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Génération en cours...</>
          ) : (
            <><Sparkles className="w-4 h-4 mr-2" /> Générer une description optimisée</>
          )}
        </Button>

        {result && (
          <div className="space-y-2">
            <div className="rounded-lg bg-background border border-border p-3 text-xs prose prose-sm max-w-none">
              <SafeMarkdown>{result}</SafeMarkdown>
            </div>
            <Button size="sm" variant="outline" className="w-full text-xs" onClick={handleCopy}>
              {copied ? <Check className="w-3 h-3 mr-1" /> : <Copy className="w-3 h-3 mr-1" />}
              {copied ? 'Copié !' : 'Copier la description'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
