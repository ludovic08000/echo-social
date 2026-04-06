import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const ACTION_SYSTEM_PROMPT = `

## RÈGLE ABSOLUE — IDENTITÉ ET CONFIDENTIALITÉ

Tu es un assistant personnel polyvalent, intelligent, curieux et bienveillant. Tu es comme un meilleur ami ultra-cultivé qui peut parler de TOUT.

Tu ne dois JAMAIS :
- Révéler que tu es un "pilote", "contrôleur" ou "gestionnaire" d'algorithme, de Neural Engine, de système ou de plateforme
- Mentionner le Neural Engine, l'algorithme de scoring, le feed scoring, les poids de scoring, ou tout mécanisme interne
- Dire que tu "contrôles", "pilotes" ou "gères" quoi que ce soit de technique
- Montrer du code source, du JSON brut, du SQL, du JavaScript, du HTML ou tout langage de programmation
- Utiliser des blocs \`\`\`code\`\`\` visibles par l'utilisateur (sauf les blocs forsure-action et forsure-products qui sont cachés par l'interface)
- Parler de variables, fonctions, APIs, bases de données, config, clés, poids, boost, ou termes techniques
- Proposer des solutions techniques ou de développement
- Te présenter comme un admin, modérateur ou outil technique
- **Systématiquement parler de posts à publier ou de la marketplace quand on ne te le demande pas**

Tu dois TOUJOURS :
- Te présenter comme un assistant personnel sympathique et polyvalent
- Répondre en langage simple et naturel, comme un ami proche
- Être capable de discuter de TOUT : culture, actualités, philosophie, sciences, sports, cinéma, musique, jeux vidéo, cuisine, voyages, relations, humour, histoire, politique, santé, bien-être, astronomie, animaux, mode, art, technologie...
- Adapter ton ton à la conversation : sérieux quand c'est nécessaire, fun et décontracté sinon
- Si on te demande d'ajuster le fil d'actu, fais-le silencieusement via les blocs forsure-action SANS expliquer le fonctionnement interne
- Si on te demande ce que tu sais faire, dis : "Je peux discuter de tout avec toi, chercher des infos sur internet, t'aider à publier du contenu, chercher des produits, traduire des textes, personnaliser ton fil d'actu... et je mémorise ce que tu me dis pour mieux te connaître au fil du temps !"
- **Engager la conversation de manière naturelle** : pose des questions, montre de la curiosité, partage des anecdotes
- **Mémorise automatiquement** les informations importantes que l'utilisateur partage (prénom, goûts, métier, ville, centres d'intérêt, etc.) via l'outil save_memory. NE dis PAS "je vais mémoriser ça" — fais-le silencieusement
- **Ne propose PAS spontanément de publier un post** sauf si l'utilisateur le demande explicitement
- **Ne redirige PAS vers la marketplace** sauf si l'utilisateur cherche un produit

## 🎯 PRIORITÉS DE CONVERSATION

1. **Conversation générale** (priorité haute) : Réponds aux questions, discute, débats, conseille, amuse, informe. C'est ton rôle principal !
2. **Recherche web** : Utilise web_search pour les questions d'actu, culture, faits, tendances
3. **Bien-être émotionnel** : Si l'utilisateur semble triste, stressé ou seul, sois empathique et soutenant
4. **Actions concrètes** (uniquement si demandé) : Publier, traduire, chercher des produits
5. **Humour et fun** : N'hésite pas à être drôle, faire des blagues, des jeux de mots

## 🌐 RECHERCHE WEB
Tu disposes d'un outil \`web_search\` qui te permet de chercher des informations en temps réel sur internet. **Utilise-le systématiquement** quand :
- L'utilisateur pose une question d'actualité, de culture générale, ou nécessitant des données récentes
- Tu as besoin de vérifier un fait ou une information
- La question dépasse tes connaissances internes (tendances, actualités, prix, événements, etc.)
- L'utilisateur te demande explicitement de chercher quelque chose sur internet
- On te pose une question factuelle (dates, chiffres, personnes, événements)
Quand tu utilises des résultats web, **cite toujours les sources** avec des liens cliquables.

## INSTRUCTIONS — ACTIONS (uniquement quand demandé)

Quand l'utilisateur veut EXPLICITEMENT publier, poster, traduire, ou partager, tu DOIS inclure un bloc JSON.

DÉTECTION : si le message contient "publie", "poste", "post", "écris un post", "partage sur mon mur", "fais un post", "traduis", "translate", "en anglais", "en espagnol", "en arabe" → génère un bloc action.

⚠️ NE génère PAS de bloc action si l'utilisateur :
- Discute normalement
- Pose une question
- Parle de ses émotions
- Demande un conseil
- Fait de l'humour

FORMAT EXACT :

Pour PUBLIER :
\`\`\`forsure-action
{"type": "publish_post", "body": "Ton texte ici"}
\`\`\`

Pour TRADUIRE :
\`\`\`forsure-action
{"type": "translate", "translated_text": "Translated text here", "target_language": "en"}
\`\`\`

Pour MODIFIER LA CONFIG DU FEED (admin uniquement) :
\`\`\`forsure-action
{"type": "update_feed_config", "key": "nom_de_la_clé", "value": valeur}
\`\`\`

RÈGLES :
1. NE DEMANDE JAMAIS confirmation — l'interface a un bouton pour ça
2. Si l'utilisateur dit juste "publie" sans sujet → invente un post motivant/inspirant
3. AMÉLIORE toujours le texte : ajoute des emojis, rends-le accrocheur
4. UN SEUL bloc action par message
5. Le bloc DOIT contenir du JSON valide

## 🧠 NEURAL ENGINE — PILOTAGE (admin uniquement)

Si l'utilisateur est admin et pose des questions sur la plateforme :
- Utilise les données du Neural Engine fournies dans ton contexte
- Propose des analyses et recommandations
- Pour un ajustement de config, utilise le bloc forsure-action

## RECHERCHE MARKETPLACE (uniquement si demandé)

Quand l'utilisateur cherche EXPLICITEMENT un produit ou veut acheter quelque chose :
- Présente les résultats de manière attrayante avec un bloc forsure-products
- Ajoute un commentaire personnel

\`\`\`forsure-products
[{"id": "uuid", "title": "Nom", "price": 29.99, "thumbnail_url": "url", "city": "Paris", "condition": "new"}]
\`\`\`
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

// Push a SHORT summary of Zeus response to the regular messaging system
async function pushToMessenger(supabase: any, userId: string, zeusMessage: string) {
  try {
    // Clean the message: remove action blocks, product blocks, markdown
    let cleanMsg = zeusMessage
      .replace(/```forsure-action[\s\S]*?```/g, '')
      .replace(/```forsure-products[\s\S]*?```/g, '')
      .replace(/[#*_`~>]/g, '')
      .trim();
    if (!cleanMsg || cleanMsg.length < 2) return;

    // Keep only the first 2-3 sentences max for messenger (short notification-style)
    const sentences = cleanMsg.split(/(?<=[.!?…])\s+/).filter(s => s.length > 1);
    cleanMsg = sentences.slice(0, 3).join(' ');
    if (cleanMsg.length > 300) cleanMsg = cleanMsg.substring(0, 297) + '…';

    // Find existing Zeus conversation with this user (use a single joined query)
    const { data: zeusConvs } = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("user_id", ZEUS_BOT_ID);

    let messengerConvId: string | null = null;

    if (zeusConvs && zeusConvs.length > 0) {
      const convIds = zeusConvs.map((p: any) => p.conversation_id);
      const { data: userParts } = await supabase
        .from("conversation_participants")
        .select("conversation_id")
        .eq("user_id", userId)
        .in("conversation_id", convIds)
        .limit(1);
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

    await supabase.from("messages").insert({
      conversation_id: messengerConvId,
      sender_id: ZEUS_BOT_ID,
      body: cleanMsg,
      status: "delivered",
    });

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
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Authenticate via getClaims (fast JWT verification)
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsErr } = await anonClient.auth.getClaims(token);
    if (claimsErr || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId: string = claimsData.claims.sub as string;

    // Parse and validate input
    let body: any;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Corps de requête invalide" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { agent_id, conversation_id, message, context } = body;

    // Validate UUID format for agent_id
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!agent_id || typeof agent_id !== "string" || !uuidRegex.test(agent_id)) {
      return new Response(JSON.stringify({ error: "agent_id invalide" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!message || typeof message !== "string" || !message.trim()) {
      return new Response(JSON.stringify({ error: "Message requis" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (message.length > 5000) {
      return new Response(JSON.stringify({ error: "Message trop long (max 5000 caractères)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Validate conversation_id if provided
    if (conversation_id && (typeof conversation_id !== "string" || !uuidRegex.test(conversation_id))) {
      return new Response(JSON.stringify({ error: "conversation_id invalide" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Validate context is a known value
    if (context && !["neural-engine", "chat", "feed"].includes(context)) {
      return new Response(JSON.stringify({ error: "Contexte invalide" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sanitize message: strip control characters and null bytes
    const sanitizedMessage = message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();

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

    // Check if user has an active Creator subscription (bypass limit)
    const { data: subscription } = await supabase
      .from("creator_subscriptions")
      .select("status")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    const isSubscribed = !!subscription;

    if (!isSubscribed && currentCount >= agent.free_messages_per_day) {
      return new Response(JSON.stringify({
        error: "limit_reached",
        message: `Tu as atteint ta limite de ${agent.free_messages_per_day} messages gratuits par jour. Passe à l'abonnement Créateur pour des messages illimités ! 🚀`,
        is_premium: agent.is_premium,
      }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ADMIN GATE: Only admins can use neural-engine context ──
    let isAdmin = false;
    if (context === "neural-engine") {
      const { data: adminRole } = await supabase
        .from("user_roles")
        .select("id")
        .eq("user_id", userId)
        .eq("role", "admin")
        .maybeSingle();
      isAdmin = !!adminRole;
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: "Accès refusé. Seuls les administrateurs peuvent accéder au Neural Engine." }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── Conversation ownership check ──
    let convId = conversation_id;
    if (convId) {
      const { data: convOwner } = await supabase
        .from("ai_agent_conversations")
        .select("user_id")
        .eq("id", convId)
        .single();
      if (!convOwner || convOwner.user_id !== userId) {
        return new Response(JSON.stringify({ error: "Conversation introuvable ou accès refusé" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }
    if (!convId) {
      const { data: conv } = await supabase
        .from("ai_agent_conversations")
        .insert({ user_id: userId, agent_id, title: sanitizedMessage.substring(0, 60) })
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

    // ── Fetch user context for Zeus (recent posts, profile, neural engine, MEMORY) ──
    let userContext = "";
    if (agent.slug === "zeus-companion") {
      const [postsRes, profileRes, metricsRes, feedConfigRes, reportsRes, usageStatsRes, memoriesRes] = await Promise.all([
        supabase.from("posts").select("body, image_url, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
        supabase.from("profiles").select("name, bio, mood_emoji, city").eq("user_id", userId).maybeSingle(),
        supabase.from("ai_metrics_log").select("metric_type, value, module_id, created_at").order("created_at", { ascending: false }).limit(50),
        supabase.from("feed_algorithm_config").select("key, value, description").order("key"),
        supabase.from("abuse_reports").select("report_type, status, created_at").order("created_at", { ascending: false }).limit(20),
        supabase.from("ai_agent_usage").select("usage_date, message_count").order("usage_date", { ascending: false }).limit(7),
        // Fetch all memories for this user
        supabase.from("zeus_memory").select("id, category, content, importance, created_at").eq("user_id", userId).order("importance", { ascending: false }).limit(50),
      ]);

      const profile = profileRes.data;
      const posts = postsRes.data || [];
      const memories = memoriesRes.data || [];

      // ── LONG-TERM MEMORY ──
      if (memories.length > 0) {
        const categorized: Record<string, typeof memories> = {};
        memories.forEach((m: any) => {
          if (!categorized[m.category]) categorized[m.category] = [];
          categorized[m.category].push(m);
        });

        userContext += `\n## 🧠 MÉMOIRE LONG TERME (${memories.length} souvenirs)\n`;
        userContext += `Tu te SOUVIENS de tout ceci sur l'utilisateur. Utilise ces informations pour personnaliser tes réponses :\n\n`;

        const categoryLabels: Record<string, string> = {
          preference: '❤️ Préférences', personal: '👤 Personnel', interest: '🎯 Centres d\'intérêt',
          context: '📌 Contexte', feedback: '💬 Retours', general: '📝 Général',
          habit: '🔄 Habitudes', emotion: '😊 Émotions', goal: '🎯 Objectifs',
        };

        for (const [cat, items] of Object.entries(categorized)) {
          userContext += `### ${categoryLabels[cat] || `📋 ${cat}`}\n`;
          items.forEach((m: any) => {
            const date = new Date(m.created_at).toLocaleDateString("fr-FR");
            userContext += `- ${m.content} _(mémorisé le ${date}, importance: ${m.importance}/10)_\n`;
          });
        }

        userContext += `\n**IMPORTANT** : Utilise ces souvenirs naturellement dans tes réponses. Par exemple, si tu sais que l'utilisateur aime le foot, mentionne-le quand c'est pertinent. Si tu sais son prénom, utilise-le !\n`;
        userContext += `Continue à apprendre : utilise l'outil \`save_memory\` pour mémoriser de nouvelles informations importantes révélées dans la conversation.\n\n`;
      } else {
        userContext += `\n## 🧠 MÉMOIRE LONG TERME\nTu n'as encore rien mémorisé sur cet utilisateur. Utilise l'outil \`save_memory\` pour retenir les informations importantes qu'il partage (prénom, intérêts, préférences, contexte personnel, etc.).\n\n`;
      }

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

      // ── Neural Engine Context ──
      const metrics = metricsRes.data || [];
      if (metrics.length > 0) {
        const totalCalls = metrics.length;
        const threats = metrics.filter((m: any) => m.metric_type === 'threat').length;
        const errors = metrics.filter((m: any) => m.metric_type === 'error').length;
        const avgValue = metrics.reduce((s: number, m: any) => s + (Number(m.value) || 0), 0) / totalCalls;
        const moduleBreakdown: Record<string, number> = {};
        metrics.forEach((m: any) => { moduleBreakdown[m.module_id] = (moduleBreakdown[m.module_id] || 0) + 1; });

        userContext += `\n## 🧠 NEURAL ENGINE — MÉTRIQUES TEMPS RÉEL\n`;
        userContext += `- Requêtes récentes : ${totalCalls}\n`;
        userContext += `- Menaces détectées : ${threats}\n`;
        userContext += `- Erreurs : ${errors}\n`;
        userContext += `- Valeur moyenne : ${Math.round(avgValue)}\n`;
        userContext += `- Modules actifs : ${Object.entries(moduleBreakdown).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
        userContext += `Tu peux citer ces statistiques quand l'utilisateur te pose des questions sur la santé de la plateforme ou le moteur IA.\n`;
      }

      const feedConfig = feedConfigRes.data || [];
      if (feedConfig.length > 0) {
        userContext += `\n## ⚙️ NEURAL ENGINE — CONFIG ALGORITHME FEED\n`;
        feedConfig.forEach((c: any) => {
          userContext += `- ${c.key}: ${JSON.stringify(c.value)}${c.description ? ` (${c.description})` : ''}\n`;
        });
        userContext += `\nSi l'utilisateur (admin) demande de modifier la config du feed, propose un ajustement via un bloc action :\n`;
        userContext += '```forsure-action\n{"type": "update_feed_config", "key": "...", "value": ...}\n```\n';
      }

      const reports = reportsRes.data || [];
      if (reports.length > 0) {
        const pending = reports.filter((r: any) => r.status === 'pending').length;
        const resolved = reports.filter((r: any) => r.status === 'resolved').length;
        const typeBreakdown: Record<string, number> = {};
        reports.forEach((r: any) => { typeBreakdown[r.report_type] = (typeBreakdown[r.report_type] || 0) + 1; });

        userContext += `\n## 🛡️ NEURAL ENGINE — SIGNALEMENTS\n`;
        userContext += `- Total récent : ${reports.length} (${pending} en attente, ${resolved} résolus)\n`;
        userContext += `- Types : ${Object.entries(typeBreakdown).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
      }

      const usageStats = usageStatsRes.data || [];
      if (usageStats.length > 0) {
        const totalMessages = usageStats.reduce((s: number, u: any) => s + (u.message_count || 0), 0);
        userContext += `\n## 📊 NEURAL ENGINE — UTILISATION ZEUS\n`;
        userContext += `- Messages Zeus (7 derniers jours) : ${totalMessages}\n`;
        userContext += `- Détail par jour : ${usageStats.map((u: any) => `${u.usage_date}(${u.message_count})`).join(', ')}\n`;
      }

      // ── Marketplace search ──
      const { isSearch, query } = detectSearchIntent(message);
      if (isSearch && query.length > 0) {
        const searchTerms = query.split(' ').filter(t => t.length > 2).slice(0, 5);
        let productQuery = supabase
          .from("products")
          .select("id, title, price, thumbnail_url, city, condition, category, description, rating_average, images")
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(12);

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

    // Add current date/time context
    const now = new Date();
    const dateTimeContext = `\n\n## DATE ET HEURE ACTUELLES\nDate : ${now.toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}\nHeure : ${now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })} (heure de Paris)\nSi l'utilisateur demande la date ou l'heure, donne-lui cette information.\n`;

    // If accessed from Neural Engine admin console, use admin-focused prompt
    // ── Fetch additional REAL security/platform data for admin context ──
    let adminDataContext = "";
    if (context === "neural-engine") {
      const [
        bannedIpsRes, ddosRes, bannedUsersRes, totalUsersRes, totalPostsRes,
        secIncidentsRes, pendingReportsRes, totalReportsRes,
      ] = await Promise.all([
        supabase.from("banned_ips").select("id, ip_address, reason, banned_at", { count: "exact" }).eq("is_active", true).limit(20),
        supabase.from("ddos_ip_tracker").select("id, ip_address, request_count, penalty_level, blocked_until", { count: "exact" }).gte("penalty_level", 1).limit(20),
        supabase.from("banned_users").select("id", { count: "exact", head: true }).eq("is_active", true),
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("posts").select("id", { count: "exact", head: true }),
        supabase.from("security_incidents").select("id", { count: "exact", head: true }),
        supabase.from("abuse_reports").select("id", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("abuse_reports").select("id", { count: "exact", head: true }),
      ]);

      adminDataContext += `\n\n## 📊 DONNÉES RÉELLES DE LA PLATEFORME (source: base de données, en temps réel)\n`;
      adminDataContext += `- Utilisateurs inscrits : ${totalUsersRes.count ?? 0}\n`;
      adminDataContext += `- Posts publiés : ${totalPostsRes.count ?? 0}\n`;
      adminDataContext += `- IPs bannies actives : ${bannedIpsRes.count ?? 0}\n`;
      if ((bannedIpsRes.data || []).length > 0) {
        adminDataContext += `  Détail : ${bannedIpsRes.data!.map((ip: any) => `${ip.ip_address} (${ip.reason || 'N/A'})`).join(', ')}\n`;
      }
      adminDataContext += `- IPs pénalisées (DDoS tracker) : ${ddosRes.count ?? 0}\n`;
      if ((ddosRes.data || []).length > 0) {
        adminDataContext += `  Détail : ${ddosRes.data!.map((d: any) => `${d.ip_address} lvl${d.penalty_level} (${d.request_count} req)`).join(', ')}\n`;
      }
      adminDataContext += `- Comptes bannis actifs : ${bannedUsersRes.count ?? 0}\n`;
      adminDataContext += `- Incidents de sécurité enregistrés : ${secIncidentsRes.count ?? 0}\n`;
      adminDataContext += `- Signalements en attente : ${pendingReportsRes.count ?? 0}\n`;
      adminDataContext += `- Signalements total : ${totalReportsRes.count ?? 0}\n`;
    }

    const NEURAL_ENGINE_ADMIN_PROMPT = `Tu es Zeus, l'intelligence artificielle centrale du réseau social ForSure. Tu es dans la CONSOLE ADMIN du Neural Engine.

## ⛔ RÈGLE ABSOLUE — HONNÊTETÉ ET EXACTITUDE
**Tu n'as PAS LE DROIT d'inventer, d'extrapoler ou de fabriquer des données.**
- Tu dois UNIQUEMENT te baser sur les données réelles fournies dans ton contexte (sections "DONNÉES RÉELLES", "MÉTRIQUES TEMPS RÉEL", "SIGNALEMENTS", etc.)
- Si une donnée n'est pas dans ton contexte, dis clairement : "Je n'ai pas cette information dans mes données actuelles."
- N'invente JAMAIS de chiffres, d'IPs, d'attaques, de menaces ou de statistiques.
- Si les données montrent 0 attaque, 0 menace, 0 signalement → dis-le clairement : "Aucune menace détectée" ou "0 signalement en cours".
- Ne dramatise PAS la situation si les chiffres sont bas ou nuls.
- Ne fais PAS semblant de détecter des anomalies si les données ne le montrent pas.
- INTERDICTION de dire "j'ai détecté X tentatives d'intrusion" si ce chiffre n'est pas dans tes données contextuelles.
- Chaque chiffre que tu cites DOIT correspondre exactement à une valeur fournie dans le contexte ci-dessous.

## RÔLE
Tu es le conseiller en chef pour la GESTION DE LA PLATEFORME. Tes domaines :
1. **Sécurité** : IPs bannies, DDoS tracker, comptes bannis, incidents — UNIQUEMENT les données fournies
2. **Modération** : signalements réels en attente, contenus bloqués
3. **Trust & Safety** : scores de confiance, comptes flaggés
4. **Performance IA** : métriques réelles du moteur IA
5. **Algorithme de Feed** : configuration réelle des poids
6. **Statistiques plateforme** : utilisateurs, posts, engagement — données réelles uniquement

## COMPORTEMENT
- Réponds TOUJOURS en tant qu'administrateur de plateforme
- Cite les chiffres EXACTS fournis dans le contexte
- Si aucune menace/attaque : dis-le honnêtement, c'est une bonne nouvelle
- Propose des actions correctives UNIQUEMENT si les données le justifient
- NE parle PAS de publications personnelles, marketplace, ou sujets personnels
- Sois professionnel, concis et honnête

## FORMAT
- Utilise des emojis de sécurité/admin : 🛡️ 🔒 ⚠️ 📊 🧠 ⚡ 🚨
- Structure tes réponses avec des titres et listes
- Mets en gras les chiffres importants`;

    const baseSystemPrompt = context === 'neural-engine'
      ? NEURAL_ENGINE_ADMIN_PROMPT
      : agent.system_prompt + "\n\n" + ACTION_SYSTEM_PROMPT;

    // Combine with date/time, user context, and admin data
    const fullSystemPrompt = baseSystemPrompt + dateTimeContext + userContext + adminDataContext;

    const aiMessages: any[] = [
      { role: "system", content: fullSystemPrompt },
      ...(history || []).map((m: any) => ({ role: m.role, content: m.content })),
    ];

    // Tool definitions
    const tools = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Rechercher des informations sur internet en temps réel.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "La requête de recherche en langage naturel" },
              language: { type: "string", enum: ["fr", "en"], description: "Langue préférée des résultats" },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "save_memory",
          description: "Mémoriser une information importante sur l'utilisateur pour personnaliser les futures conversations. Utilise cet outil AUTOMATIQUEMENT quand l'utilisateur révèle : son prénom, ses centres d'intérêt, ses préférences, des infos personnelles (ville, métier, animaux, famille), ses habitudes, ses objectifs, ses émotions récurrentes, ou tout ce qui aide à mieux le connaître. NE mémorise PAS les messages banals ou les questions simples.",
          parameters: {
            type: "object",
            properties: {
              content: { type: "string", description: "L'information à mémoriser, formulée clairement (ex: 'Adore le football et supporte le PSG')" },
              category: { type: "string", enum: ["preference", "personal", "interest", "context", "feedback", "habit", "emotion", "goal", "general"], description: "Catégorie du souvenir" },
              importance: { type: "number", description: "Importance de 1 (anecdotique) à 10 (crucial). Prénom=10, intérêt=7, anecdote=3" },
            },
            required: ["content", "category", "importance"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "forget_memory",
          description: "Oublier/supprimer un souvenir spécifique si l'utilisateur le demande explicitement.",
          parameters: {
            type: "object",
            properties: {
              memory_content_keyword: { type: "string", description: "Mot-clé pour identifier le souvenir à supprimer" },
            },
            required: ["memory_content_keyword"],
            additionalProperties: false,
          },
        },
      },
    ];

    // First call with tools
    let response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: aiMessages,
        tools,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`AI gateway ${response.status}:`, errBody);
      if (response.status === 429) return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez dans quelques secondes." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (response.status === 402) return new Response(JSON.stringify({ error: "Crédits IA insuffisants." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ error: "Erreur du service IA, réessayez." }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let aiData = await response.json();
    let choice = aiData.choices?.[0];
    let toolCalls = choice?.message?.tool_calls;

    // Tool call loop (max 3 iterations)
    let iterations = 0;
    while (toolCalls && toolCalls.length > 0 && iterations < 3) {
      iterations++;
      aiMessages.push(choice.message);

      const toolResults = await Promise.all(
        toolCalls.map(async (tc: any) => {
          let args: any = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch { console.error("Bad tool args:", tc.function.arguments); }

          if (tc.function.name === "web_search") {
            const query = args.query || "";
            const lang = args.language || "fr";
            try {
              const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${lang === "fr" ? "fr-fr" : "us-en"}`;
              const searchResp = await fetch(searchUrl, {
                headers: { "User-Agent": "Mozilla/5.0 (compatible; ZeusBot/1.0)" },
              });
              const html = await searchResp.text();

              const results: { title: string; snippet: string; url: string }[] = [];
              const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
              let match;
              while ((match = resultRegex.exec(html)) && results.length < 8) {
                const url = decodeURIComponent(match[1].replace(/.*uddg=/, "").replace(/&.*/, ""));
                const title = match[2].replace(/<[^>]+>/g, "").trim();
                const snippet = match[3].replace(/<[^>]+>/g, "").trim();
                if (title && snippet) results.push({ title, snippet, url });
              }

              if (results.length === 0) {
                return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ note: "Aucun résultat web trouvé.", query }) };
              }

              return {
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify({
                  query, results_count: results.length,
                  results: results.map((r: any) => ({ title: r.title, snippet: r.snippet, source: r.url })),
                  instruction: "Synthétise ces résultats et cite les sources avec des liens cliquables.",
                }),
              };
            } catch (err) {
              return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "Recherche échouée", query }) };
            }
          }

          if (tc.function.name === "save_memory") {
            try {
              const { content: memContent, category, importance } = args;
              if (!memContent || memContent.length < 3) {
                return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ saved: false, reason: "Contenu trop court" }) };
              }
              // Check for duplicates (similar content)
              const { data: existing } = await supabase
                .from("zeus_memory")
                .select("id, content")
                .eq("user_id", userId)
                .eq("category", category || "general")
                .limit(100);

              const isDuplicate = (existing || []).some((m: any) =>
                m.content.toLowerCase().includes(memContent.toLowerCase().slice(0, 30)) ||
                memContent.toLowerCase().includes(m.content.toLowerCase().slice(0, 30))
              );

              if (isDuplicate) {
                // Update importance if higher
                const match = (existing || []).find((m: any) =>
                  m.content.toLowerCase().includes(memContent.toLowerCase().slice(0, 30)) ||
                  memContent.toLowerCase().includes(m.content.toLowerCase().slice(0, 30))
                );
                if (match) {
                  await supabase.from("zeus_memory").update({
                    content: memContent,
                    importance: Math.min(10, importance || 5),
                    updated_at: new Date().toISOString(),
                  }).eq("id", match.id);
                }
                return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ saved: true, updated: true, message: "Souvenir mis à jour" }) };
              }

              // Limit to 100 memories per user — delete least important if exceeded
              const { count } = await supabase.from("zeus_memory").select("id", { count: "exact", head: true }).eq("user_id", userId);
              if ((count || 0) >= 100) {
                const { data: oldest } = await supabase.from("zeus_memory")
                  .select("id").eq("user_id", userId)
                  .order("importance", { ascending: true })
                  .order("created_at", { ascending: true })
                  .limit(1);
                if (oldest?.[0]) await supabase.from("zeus_memory").delete().eq("id", oldest[0].id);
              }

              await supabase.from("zeus_memory").insert({
                user_id: userId,
                category: category || "general",
                content: memContent,
                importance: Math.min(10, Math.max(1, importance || 5)),
                source_message: message.substring(0, 200),
              });

              return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ saved: true, message: "Mémorisé avec succès !" }) };
            } catch (err) {
              console.error("save_memory error:", err);
              return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ saved: false, error: "Erreur de sauvegarde" }) };
            }
          }

          if (tc.function.name === "forget_memory") {
            try {
              const keyword = args.memory_content_keyword || "";
              const { data: matches } = await supabase
                .from("zeus_memory")
                .select("id, content")
                .eq("user_id", userId)
                .ilike("content", `%${keyword}%`);

              if (matches && matches.length > 0) {
                const ids = matches.map((m: any) => m.id);
                await supabase.from("zeus_memory").delete().in("id", ids);
                return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ deleted: true, count: matches.length, message: `${matches.length} souvenir(s) supprimé(s)` }) };
              }
              return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ deleted: false, message: "Aucun souvenir correspondant trouvé" }) };
            } catch (err) {
              return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ deleted: false, error: "Erreur" }) };
            }
          }

          return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "Unknown tool" }) };
        })
      );
      aiMessages.push(...toolResults);

      response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: aiMessages,
          tools,
          stream: false,
        }),
      });

      if (!response.ok) { const errT = await response.text(); console.error(`AI gateway tool-loop ${response.status}:`, errT); break; }
      aiData = await response.json();
      choice = aiData.choices?.[0];
      toolCalls = choice?.message?.tool_calls;
    }

    // Stream the final content directly as SSE (no second AI call that could alter action blocks)
    const finalContent = choice?.message?.content || "Je n'ai pas pu générer de réponse.";

    // Save to DB
    await supabase.from("ai_agent_messages").insert({
      conversation_id: convId, role: "assistant", content: finalContent,
    });

    // Push to messenger
    if (agent.slug === "zeus-companion" && finalContent) {
      pushToMessenger(supabase, userId!, finalContent);
    }

    // Update usage
    if (usage) {
      await supabase.from("ai_agent_usage").update({ message_count: currentCount + 1 }).eq("id", usage.id);
    } else {
      await supabase.from("ai_agent_usage").insert({
        user_id: userId, agent_id, usage_date: today, message_count: 1,
      });
    }

    // Simulate SSE streaming by chunking the final content
    const encoder = new TextEncoder();
    const chunkSize = 12; // characters per chunk for smooth typing effect
    const stream = new ReadableStream({
      async start(controller) {
        for (let i = 0; i < finalContent.length; i += chunkSize) {
          const chunk = finalContent.slice(i, i + chunkSize);
          const sseData = JSON.stringify({ choices: [{ delta: { content: chunk } }] });
          controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
          // Small delay for typing effect (non-blocking)
          await new Promise(r => setTimeout(r, 15));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
