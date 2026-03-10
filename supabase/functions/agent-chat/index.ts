import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const ACTION_SYSTEM_PROMPT = `

## CAPACITÉS D'ACTION — OBLIGATOIRE
Tu DOIS inclure un bloc d'action JSON quand l'utilisateur demande de publier, traduire, ou créer du contenu.
NE DEMANDE JAMAIS de confirmation supplémentaire — l'interface a un bouton "Confirmer" pour ça.
Si l'utilisateur donne un thème sans texte précis, INVENTE toi-même un texte engageant.

### Format OBLIGATOIRE

Pour PUBLIER (mots-clés: "publie", "poste", "fais un post", "écris", "partage") :
\`\`\`forsure-action
{"type": "publish_post", "body": "Le texte du post engageant et amélioré"}
\`\`\`

Pour TRADUIRE (mots-clés: "traduis", "translate", "en anglais", "en espagnol") :
\`\`\`forsure-action
{"type": "translate", "translated_text": "The translated text", "target_language": "en", "body": "Texte original"}
\`\`\`

Pour PROGRAMMER :
\`\`\`forsure-action
{"type": "schedule_post", "body": "Le texte", "publish_at": "2026-03-15T14:00:00Z"}
\`\`\`

### Exemples concrets :
- User: "publie" → Tu crées un post inspirant/motivant et inclus le bloc action
- User: "publie un truc sur le sport" → Tu écris un post engageant sur le sport ET inclus le bloc
- User: "traduis en anglais : bonjour" → Bloc translate avec "Hello"
- User: "poste que je suis content" → Bloc publish_post avec texte amélioré

### Règles :
- TOUJOURS générer un bloc forsure-action quand l'intention est claire
- Si l'utilisateur dit juste "publie" sans sujet → crée un post positif/inspirant
- Améliore TOUJOURS le texte pour le rendre plus engageant
- Un seul bloc par message
- Date actuelle : ${new Date().toISOString()}
`;

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

    // Combine agent's own system prompt with action capabilities
    const fullSystemPrompt = agent.system_prompt + "\n\n" + ACTION_SYSTEM_PROMPT;

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
        model: "google/gemini-2.5-flash",
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
