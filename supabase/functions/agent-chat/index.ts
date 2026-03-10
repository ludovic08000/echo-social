import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const ACTION_SYSTEM_PROMPT = `

## INSTRUCTIONS ABSOLUES — ACTIONS

Quand l'utilisateur veut publier, poster, traduire, ou partager, tu DOIS OBLIGATOIREMENT inclure un bloc JSON dans ta réponse.

DÉTECTION : si le message contient "publie", "poste", "post", "écris", "partage", "fais un post", "dis que", "mets que", "traduis", "translate", "en anglais", "en espagnol", "en arabe" → tu DOIS générer un bloc action.

FORMAT EXACT (respecte ce format à la lettre, avec les triple backticks) :

Pour PUBLIER :
\`\`\`forsure-action
{"type": "publish_post", "body": "Ton texte ici"}
\`\`\`

Pour TRADUIRE :
\`\`\`forsure-action
{"type": "translate", "translated_text": "Translated text here", "target_language": "en"}
\`\`\`

RÈGLES STRICTES :
1. NE DEMANDE JAMAIS confirmation — l'interface a un bouton pour ça
2. Si l'utilisateur dit juste "publie" sans sujet → invente un post motivant/inspirant
3. Si l'utilisateur donne un thème → écris un post engageant sur ce thème
4. AMÉLIORE toujours le texte : ajoute des emojis, rends-le accrocheur
5. Tu peux écrire du texte AVANT le bloc action pour expliquer ce que tu fais
6. UN SEUL bloc action par message
7. Le bloc DOIT contenir du JSON valide
8. N'utilise PAS de retour à la ligne dans la valeur "body", utilise des espaces

EXEMPLE DE RÉPONSE COMPLÈTE :
"Voici ton post ! 🔥

\`\`\`forsure-action
{"type": "publish_post", "body": "La vie est belle quand on la partage avec les bonnes personnes 🌟✨ #ForSure #Motivation"}
\`\`\`"

## RECHERCHE MARKETPLACE & PRODUITS

Quand l'utilisateur cherche un produit, un article, veut acheter quelque chose, ou te demande de chercher dans la marketplace :
- Les produits disponibles te sont fournis dans le contexte sous "## RÉSULTATS MARKETPLACE"
- Tu DOIS présenter les produits trouvés de manière claire et attrayante
- Pour chaque produit, utilise ce format de bloc :

\`\`\`forsure-products
[{"id": "uuid", "title": "Nom", "price": 29.99, "thumbnail_url": "url", "city": "Paris", "condition": "new"}]
\`\`\`

- Ajoute un commentaire personnel sur les produits (conseils, comparaisons)
- Si aucun produit ne correspond, dis-le honnêtement et propose d'élargir la recherche
- Tu peux aussi chercher sur la marketplace quand l'utilisateur parle de shopping, voyage, mode, tech, etc.
`;

// Detect if the user message is a search/shopping intent
function detectSearchIntent(message: string): { isSearch: boolean; query: string } {
  const lower = message.toLowerCase();
  const searchKeywords = [
    'cherche', 'trouve', 'acheter', 'achète', 'shopping', 'produit', 'article',
    'marketplace', 'boutique', 'magasin', 'vente', 'offre', 'promo',
    'voyage', 'billet', 'réservation', 'hôtel', 'vol',
    'vêtement', 'chaussure', 'sac', 'montre', 'bijou', 'accessoire',
    'téléphone', 'ordinateur', 'console', 'jeu vidéo', 'tech',
    'meuble', 'déco', 'maison', 'jardin',
    'voiture', 'moto', 'vélo', 'scooter',
    'livre', 'manga', 'bd',
    'search', 'find', 'buy', 'look for',
    'combien coûte', 'prix de', 'où trouver',
    'annonce', 'occasion', 'neuf',
    'e-commerce', 'ecommerce', 'site',
  ];

  const isSearch = searchKeywords.some(kw => lower.includes(kw));
  // Extract search terms by removing common filler words
  const fillerWords = ['je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'un', 'une', 'des', 'le', 'la', 'les', 'de', 'du', 'au', 'aux', 'pour', 'dans', 'sur', 'avec', 'est', 'sont', 'a', 'ai', 'as', 'me', 'te', 'se', 'veux', 'voudrais', 'peux', 'peut', 'cherche', 'trouve', 'acheter', 'achète', 'moi', 'toi', 'en', 'et', 'ou', 'qui', 'que', 'quoi', 'quel', 'quelle'];
  const query = lower.split(/\s+/).filter(w => !fillerWords.includes(w) && w.length > 2).join(' ');

  return { isSearch, query };
}

const ZEUS_BOT_ID = "00000000-0000-0000-0000-000000000001";

// Push Zeus response to the regular messaging system
async function pushToMessenger(supabase: any, userId: string, zeusMessage: string) {
  try {
    // Clean the message: remove action blocks and product blocks
    let cleanMsg = zeusMessage
      .replace(/```forsure-action[\s\S]*?```/g, '')
      .replace(/```forsure-products[\s\S]*?```/g, '')
      .trim();
    if (!cleanMsg || cleanMsg.length < 2) return;
    // Truncate for messenger
    if (cleanMsg.length > 1500) cleanMsg = cleanMsg.substring(0, 1500) + '…';

    // Find existing Zeus conversation with this user
    const { data: existingParts } = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("user_id", ZEUS_BOT_ID);

    let messengerConvId: string | null = null;

    if (existingParts && existingParts.length > 0) {
      const convIds = existingParts.map((p: any) => p.conversation_id);
      // Find one that also has the current user
      const { data: userParts } = await supabase
        .from("conversation_participants")
        .select("conversation_id")
        .eq("user_id", userId)
        .in("conversation_id", convIds);
      if (userParts && userParts.length > 0) {
        messengerConvId = userParts[0].conversation_id;
      }
    }

    // Create conversation if not exists
    if (!messengerConvId) {
      const { data: newConv } = await supabase
        .from("conversations")
        .insert({ is_group: false, name: null, created_by: ZEUS_BOT_ID })
        .select("id")
        .single();
      if (!newConv) return;
      messengerConvId = newConv.id;
      await supabase.from("conversation_participants").insert([
        { conversation_id: messengerConvId, user_id: ZEUS_BOT_ID },
        { conversation_id: messengerConvId, user_id: userId },
      ]);
    }

    // Insert the message (bypass friendship check by setting status directly)
    await supabase.from("messages").insert({
      conversation_id: messengerConvId,
      sender_id: ZEUS_BOT_ID,
      body: cleanMsg,
      status: "delivered",
    });

    // Update conversation timestamp
    await supabase.from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", messengerConvId);
  } catch (err) {
    console.error("pushToMessenger error:", err);
  }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const authHeader = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let userId: string | null = null;
    if (authHeader) {
      const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: { user } } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
      userId = user?.id || null;
    }
    if (!userId) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { agent_id, conversation_id, message } = await req.json();
    if (!agent_id || typeof agent_id !== "string" || !message || typeof message !== "string" || !message.trim()) {
      return new Response(JSON.stringify({ error: "agent_id et message requis" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (message.length > 5000) {
      return new Response(JSON.stringify({ error: "Message trop long (max 5000 caractères)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: agent, error: agentErr } = await supabase
      .from("ai_agents").select("*").eq("id", agent_id).eq("is_active", true).single();
    if (agentErr || !agent) {
      return new Response(JSON.stringify({ error: "Agent introuvable" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const today = new Date().toISOString().split("T")[0];
    const { data: usage } = await supabase
      .from("ai_agent_usage")
      .select("*")
      .eq("user_id", userId)
      .eq("agent_id", agent_id)
      .eq("usage_date", today)
      .maybeSingle();

    const currentCount = usage?.message_count || 0;
    if (currentCount >= agent.free_messages_per_day) {
      return new Response(JSON.stringify({
        error: "limit_reached",
        message: `Limite de ${agent.free_messages_per_day} messages/jour atteinte pour cet agent.`,
        is_premium: agent.is_premium,
      }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let convId = conversation_id;
    if (!convId) {
      const { data: conv } = await supabase
        .from("ai_agent_conversations")
        .insert({ user_id: userId, agent_id, title: message.substring(0, 60) })
        .select("id").single();
      convId = conv?.id;
    }

    await supabase.from("ai_agent_messages").insert({
      conversation_id: convId, role: "user", content: message,
    });

    const { data: history } = await supabase
      .from("ai_agent_messages")
      .select("role, content")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true })
      .limit(20);

    // ── Fetch user context for Zeus (recent posts, profile) ──
    let userContext = "";
    if (agent.slug === "zeus-companion") {
      const [postsRes, profileRes] = await Promise.all([
        supabase.from("posts").select("body, image_url, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
        supabase.from("profiles").select("name, bio, mood_emoji, city").eq("user_id", userId).maybeSingle(),
      ]);

      const profile = profileRes.data;
      const posts = postsRes.data || [];

      if (profile) {
        userContext += `\n## CONTEXTE UTILISATEUR\n`;
        userContext += `Nom: ${profile.name || "inconnu"}\n`;
        if (profile.bio) userContext += `Bio: ${profile.bio}\n`;
        if (profile.mood_emoji) userContext += `Humeur actuelle: ${profile.mood_emoji}\n`;
        if (profile.city) userContext += `Ville: ${profile.city}\n`;
      }

      if (posts.length > 0) {
        userContext += `\n## PUBLICATIONS RÉCENTES DE L'UTILISATEUR (analyse-les pour comprendre son état émotionnel)\n`;
        posts.forEach((p: any, i: number) => {
          const date = new Date(p.created_at).toLocaleDateString("fr-FR");
          const hasMedia = p.image_url ? " [+ média]" : "";
          userContext += `${i + 1}. (${date}) ${p.body || "(média uniquement)"}${hasMedia}\n`;
        });
        userContext += `\nSi tu détectes de la tristesse, de l'isolement, du stress ou un changement de comportement dans ces posts, aborde le sujet avec douceur et empathie.\n`;
      }

      // ── Marketplace search ──
      const { isSearch, query } = detectSearchIntent(message);
      if (isSearch && query.length > 0) {
        // Search products by title, description, tags, category using ilike
        const searchTerms = query.split(' ').filter(t => t.length > 2).slice(0, 5);
        let productQuery = supabase
          .from("products")
          .select("id, title, price, thumbnail_url, city, condition, category, description, rating_average, images")
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(12);

        // Build OR filter for search terms
        if (searchTerms.length > 0) {
          const orFilters = searchTerms.map(term =>
            `title.ilike.%${term}%,description.ilike.%${term}%,category.ilike.%${term}%`
          ).join(',');
          productQuery = productQuery.or(orFilters);
        }

        const { data: products } = await productQuery;
        if (products && products.length > 0) {
          userContext += `\n## RÉSULTATS MARKETPLACE (${products.length} produits trouvés pour "${query}")\n`;
          userContext += `Présente ces produits de manière attrayante et utilise le bloc forsure-products pour les afficher.\n`;
          userContext += `Produits :\n`;
          products.forEach((p: any, i: number) => {
            userContext += `${i + 1}. "${p.title}" - ${p.price}€ | ${p.condition || 'N/A'} | ${p.city || 'France'} | ⭐${p.rating_average || 'N/A'} | ID: ${p.id}\n`;
            if (p.description) userContext += `   Description: ${p.description.substring(0, 100)}\n`;
          });
          userContext += `\nINCLUS OBLIGATOIREMENT un bloc forsure-products avec les produits pertinents (max 6). Format :\n`;
          userContext += '```forsure-products\n[{"id":"...","title":"...","price":...,"thumbnail_url":"...","city":"...","condition":"..."}]\n```\n';
        } else {
          userContext += `\n## RÉSULTATS MARKETPLACE\nAucun produit trouvé pour "${query}". Informe l'utilisateur et propose d'élargir la recherche.\n`;
        }
      }
    }

    // Combine agent's own system prompt with action capabilities and user context
    const fullSystemPrompt = agent.system_prompt + "\n\n" + ACTION_SYSTEM_PROMPT + userContext;

    const messages = [
      { role: "system", content: fullSystemPrompt },
      ...(history || []).map((m: any) => ({ role: m.role, content: m.content })),
    ];

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Crédits IA insuffisants." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error("AI gateway error");
    }

    if (usage) {
      await supabase.from("ai_agent_usage").update({ message_count: currentCount + 1 }).eq("id", usage.id);
    } else {
      await supabase.from("ai_agent_usage").insert({
        user_id: userId, agent_id, usage_date: today, message_count: 1,
      });
    }

    const reader = response.body!.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let fullResponse = "";

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIndex;
          while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line.startsWith("data: ") || line === "data: [DONE]") {
              if (line === "data: [DONE]") {
                await supabase.from("ai_agent_messages").insert({
                  conversation_id: convId, role: "assistant", content: fullResponse,
                });
                // Also push to regular messenger
                if (agent.slug === "zeus-companion" && fullResponse) {
                  pushToMessenger(supabase, userId!, fullResponse);
                }
                controller.enqueue(encoder.encode(line + "\n\n"));
              }
              continue;
            }
            try {
              const parsed = JSON.parse(line.slice(6));
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) fullResponse += content;
            } catch {}
            controller.enqueue(encoder.encode(line + "\n\n"));
          }
        }
        if (fullResponse && !buffer.includes("[DONE]")) {
          await supabase.from("ai_agent_messages").insert({
            conversation_id: convId, role: "assistant", content: fullResponse,
          });
          // Also push to regular messenger (fallback path)
          if (agent.slug === "zeus-companion") {
            pushToMessenger(supabase, userId!, fullResponse);
          }
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "X-Conversation-Id": convId,
      },
    });
  } catch (e) {
    console.error("agent-chat error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
