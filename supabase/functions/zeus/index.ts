import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// ═══════════════════════════════════════════════════════════════
// ⚡ ZEUS — ForSure Central AI Engine
// All AI capabilities in one unified function
// Domains: content, moderation, ads, seller, photo, agents
// ═══════════════════════════════════════════════════════════════

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

// ── Rate limiting ──
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(userId: string, limit = 20): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// ── Helpers ──
async function hashContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(content.toLowerCase().trim());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function callAI(apiKey: string, payload: any): Promise<Response> {
  return fetch(AI_GATEWAY, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function aiError(status: number, corsHeaders: Record<string, string>): Response | null {
  if (status === 429) return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (status === 402) return new Response(JSON.stringify({ error: "Crédits IA insuffisants." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  return null;
}

// ── Image generation helper (for ads) ──
async function generateAdImage(apiKey: string, title: string, description: string): Promise<string | null> {
  try {
    const resp = await callAI(apiKey, {
      model: "google/gemini-2.5-flash-image",
      messages: [{ role: "user", content: `Create a professional social media ad image for: "${title}". About: "${description}". Vibrant, modern, no text.` }],
      modalities: ["image", "text"],
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.images?.[0]?.image_url?.url || null;
  } catch { return null; }
}

async function uploadBase64ToStorage(base64Url: string): Promise<string | null> {
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const matches = base64Url.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!matches) return null;
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const bytes = Uint8Array.from(atob(matches[2]), c => c.charCodeAt(0));
    const fileName = `ad-${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('post-images').upload(fileName, bytes, { contentType: `image/${matches[1]}`, upsert: true });
    if (error) return null;
    return supabase.storage.from('post-images').getPublicUrl(fileName).data.publicUrl;
  } catch { return null; }
}

// ── Market data for seller coach ──
async function fetchMarketData(sb: any) {
  try {
    const { data: products } = await sb.from("products").select("category, price, title, seller_id, stock_quantity, description, product_type").eq("is_active", true);
    if (!products?.length) return "";
    const catStats: Record<string, { prices: number[]; count: number }> = {};
    for (const p of products) {
      const cat = p.category || "general";
      if (!catStats[cat]) catStats[cat] = { prices: [], count: 0 };
      catStats[cat].prices.push(Number(p.price));
      catStats[cat].count++;
    }
    return Object.entries(catStats).map(([cat, s]) => {
      const avg = (s.prices.reduce((a, b) => a + b, 0) / s.prices.length).toFixed(2);
      return `  • ${cat}: ${s.count} produits, moy ${avg}€`;
    }).join("\n");
  } catch { return ""; }
}

// ═══════════════════════════════════════════════════════════════
// DOMAIN HANDLERS
// ═══════════════════════════════════════════════════════════════

// ── CONTENT: summarize, translate, correct, improve ──
async function handleContent(apiKey: string, body: any, cors: Record<string, string>) {
  const { action, text, targetLanguage, tone } = body;
  const allowed = ["summarize", "translate", "correct", "improve"];
  if (!allowed.includes(action)) return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  if (!text || text.length > 5000) return new Response(JSON.stringify({ error: "Texte invalide ou trop long" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

  let systemPrompt = "";
  if (action === "summarize") systemPrompt = "You are an expert summarizer. Provide a concise summary in 2-3 sentences. Keep the same language. Only output the summary.";
  else if (action === "translate") {
    const lang = ["en","fr","es","de","it","pt","ar","zh","ja","ko"].includes(targetLanguage) ? targetLanguage : "en";
    systemPrompt = `Translate to ${lang}. Only output the translation. Preserve tone and meaning.`;
  } else if (action === "correct") systemPrompt = "Fix spelling, grammar, and punctuation. Keep same language and tone. Only output corrected text.";
  else {
    const toneMap: Record<string, string> = { formal: "professional", friendly: "warmer and friendly", funny: "funnier", poetic: "more poetic" };
    systemPrompt = `Improve this message. Make it ${toneMap[tone] || "better"}. Keep same language. Only output improved text.`;
  }

  const model = ["correct", "translate"].includes(action) ? "google/gemini-2.5-flash-lite" : "google/gemini-3-flash-preview";
  const resp = await callAI(apiKey, { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }] });
  const errResp = aiError(resp.status, cors);
  if (errResp) return errResp;
  if (!resp.ok) return new Response(JSON.stringify({ error: "Erreur IA" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  const data = await resp.json();
  return new Response(JSON.stringify({ result: data.choices?.[0]?.message?.content || "" }), { headers: { ...cors, "Content-Type": "application/json" } });
}

// ── POST ASSISTANT: improve, formal, casual, shorter, longer ──
async function handlePostAssistant(apiKey: string, body: any, cors: Record<string, string>) {
  const { text, action } = body;
  if (!text?.trim() || text.length > 5000) return new Response(JSON.stringify({ error: "Texte invalide" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  const safeAction = ["improve","formal","casual","shorter","longer"].includes(action) ? action : "improve";

  const systemPrompt = `Tu es un assistant d'écriture pour un réseau social. Tu DOIS répondre en utilisant l'outil improve_text.
- "improve" : Corrige et améliore le style. Garde la langue originale.
- "formal" : Rends plus professionnel.
- "casual" : Rends plus décontracté.
- "shorter" : Raccourcis en gardant l'essentiel.
- "longer" : Développe avec plus de détails.
Détecte la langue et indique-la dans detected_language.`;

  const resp = await callAI(apiKey, {
    model: "google/gemini-3-flash-preview",
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Action: ${safeAction}\n\nTexte:\n${text}` }],
    tools: [{
      type: "function", function: {
        name: "improve_text", description: "Retourne le texte amélioré",
        parameters: { type: "object", properties: { improved_text: { type: "string" }, detected_language: { type: "string" }, corrections: { type: "array", items: { type: "string" } }, tone: { type: "string" } }, required: ["improved_text", "detected_language", "corrections", "tone"], additionalProperties: false },
      },
    }],
    tool_choice: { type: "function", function: { name: "improve_text" } },
  });
  const errResp = aiError(resp.status, cors);
  if (errResp) return errResp;
  if (!resp.ok) return new Response(JSON.stringify({ error: "Erreur IA" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  const data = await resp.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.name === "improve_text") {
    return new Response(JSON.stringify(JSON.parse(toolCall.function.arguments)), { headers: { ...cors, "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ improved_text: text, detected_language: "unknown", corrections: [], tone: "neutral" }), { headers: { ...cors, "Content-Type": "application/json" } });
}

// ── MODERATION: moderate_message, accept_request, reject_request ──
async function handleModeration(apiKey: string, body: any, userId: string, supabase: any, cors: Record<string, string>) {
  const { action } = body;

  if (action === "moderate_message") {
    const { messageBody, messageId } = body;
    if (!messageBody || typeof messageBody !== "string") return new Response(JSON.stringify({ error: "messageBody required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    // Skip system messages
    if (messageBody.startsWith("📞 CALL:") || messageBody.startsWith("🎙️ voice:") || messageBody === "📷 Photo") {
      return new Response(JSON.stringify({ safe: true, reason: null }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Check if recipient is minor
    let recipientIsMinor = false;
    if (messageId) {
      const { data: msg } = await supabase.from("messages").select("conversation_id").eq("id", messageId).maybeSingle();
      if (msg) {
        const { data: other } = await supabase.from("conversation_participants").select("user_id").eq("conversation_id", msg.conversation_id).neq("user_id", userId).maybeSingle();
        if (other) {
          const { data: mc } = await supabase.from("parental_controls").select("is_active").eq("user_id", other.user_id).eq("is_active", true).maybeSingle();
          recipientIsMinor = !!mc;
          if (recipientIsMinor) await supabase.from("minor_contact_logs").insert({ adult_user_id: userId, minor_user_id: other.user_id, contact_type: "message" });
        }
      }
    }

    // Basic moderation for short messages (unless minor)
    if (messageBody.length < 15 && !recipientIsMinor) {
      const result = basicModeration(messageBody);
      if (!result.safe && messageId) await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
      return new Response(JSON.stringify(result), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Cache check
    const cacheKey = recipientIsMinor ? `minor:${messageBody}` : messageBody;
    const contentHash = await hashContent(cacheKey);
    const { data: cached } = await supabase.from("ai_moderation_cache").select("result").eq("content_hash", contentHash).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (cached) {
      const r = cached.result as any;
      if (!r.safe && messageId) await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
      return new Response(JSON.stringify(r), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // AI fallback
    if (!apiKey) {
      const result = recipientIsMinor ? basicMinorModeration(messageBody) : basicModeration(messageBody);
      if (!result.safe && messageId) await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
      return new Response(JSON.stringify(result), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const systemPrompt = recipientIsMinor
      ? `Tu es un système de protection des mineurs pour un réseau social français.
Analyse les messages envoyés par des adultes à des mineurs de moins de 16 ans.
Détecte : grooming (flatterie, "notre secret"), isolation ("ne dis pas à tes parents"), personal_info (demande adresse/école/photos), inappropriate (contenu sexuel), manipulation (chantage), scam, harassment.
En cas de doute, signale. La sécurité du mineur prime.`
      : `Tu es un modérateur de contenu pour un réseau social français.
Catégories dangereuses : spam, harassment, scam, explicit, threats, hate_speech, unsolicited_ads.`;

    const categories = recipientIsMinor
      ? ["grooming", "isolation", "personal_info", "inappropriate", "manipulation", "scam", "harassment", "safe"]
      : ["spam", "harassment", "scam", "explicit", "threats", "hate_speech", "unsolicited_ads", "safe"];

    const resp = await callAI(apiKey, {
      model: "google/gemini-3-flash-preview",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Analyse ce message : "${messageBody.slice(0, 500)}"` }],
      tools: [{ type: "function", function: { name: "moderation_result", description: "Moderation result", parameters: { type: "object", properties: { safe: { type: "boolean" }, reason: { type: "string" }, category: { type: "string", enum: categories }, confidence: { type: "number" }, severity: { type: "string", enum: ["low","medium","high","critical"] } }, required: ["safe","category","confidence","severity"], additionalProperties: false } } }],
      tool_choice: { type: "function", function: { name: "moderation_result" } },
    });

    if (!resp.ok) {
      const result = recipientIsMinor ? basicMinorModeration(messageBody) : basicModeration(messageBody);
      if (!result.safe && messageId) await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
      return new Response(JSON.stringify(result), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const aiData = await resp.json();
    let modResult = { safe: true, reason: null as string | null, category: "safe", confidence: 50, severity: "low" };
    try { const tc = aiData.choices?.[0]?.message?.tool_calls?.[0]; if (tc?.function?.arguments) modResult = JSON.parse(tc.function.arguments); } catch {}

    await supabase.from("ai_moderation_cache").insert({ content_hash: contentHash, result: modResult, expires_at: new Date(Date.now() + (recipientIsMinor ? 3600000 : 21600000)).toISOString() });

    const threshold = recipientIsMinor ? 50 : 70;
    if (!modResult.safe && modResult.confidence >= threshold && messageId) {
      await supabase.from("messages").update({ status: "blocked" }).eq("id", messageId);
      await supabase.from("trust_scores").update({ is_flagged: true, flag_reason: `${recipientIsMinor ? "⚠️ MINOR" : "Blocked"}: ${modResult.category}`, updated_at: new Date().toISOString() }).eq("user_id", userId);
      if (recipientIsMinor && ["critical","high"].includes(modResult.severity)) {
        await supabase.from("abuse_reports").insert({ reporter_id: userId, reported_user_id: userId, report_type: `ai_minor_${modResult.category}`, description: `[AUTO] ${modResult.reason}. Sévérité: ${modResult.severity}` });
      }
    }

    return new Response(JSON.stringify({ safe: modResult.safe, reason: modResult.reason, category: modResult.category, minorProtection: recipientIsMinor }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  // accept / reject request
  if (action === "accept_request" || action === "reject_request") {
    const { conversationId } = body;
    if (!conversationId) return new Response(JSON.stringify({ error: "conversationId required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const { data: p } = await supabase.from("conversation_participants").select("id").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
    if (!p) return new Response(JSON.stringify({ error: "Pas participant" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
    const newStatus = action === "accept_request" ? "delivered" : "blocked";
    await supabase.from("messages").update({ status: newStatus }).eq("conversation_id", conversationId).eq("status", "pending");
    return new Response(JSON.stringify({ [action === "accept_request" ? "accepted" : "rejected"]: true }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "Unknown moderation action" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
}

// ── ADS: chat, generate_ad, moderate_ad, generate_image ──
async function handleAds(apiKey: string, body: any, cors: Record<string, string>) {
  const { action } = body;

  if (action === "generate_image") {
    const base64 = await generateAdImage(apiKey, body.title, body.description);
    if (base64) { const url = await uploadBase64ToStorage(base64); return new Response(JSON.stringify({ image_url: url }), { headers: { ...cors, "Content-Type": "application/json" } }); }
    return new Response(JSON.stringify({ error: "Image generation failed" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  if (action === "chat") {
    const resp = await callAI(apiKey, {
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: "Tu es l'assistant publicitaire IA de ForSure Ads. Aide à créer des pubs performantes. Concis, pro, en français." },
        ...body.messages,
      ],
      tools: [{ type: "function", function: { name: "generate_ad_campaign", description: "Génère une campagne pub complète", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, cta_text: { type: "string" }, target_age_min: { type: "number" }, target_age_max: { type: "number" }, target_gender: { type: "string", enum: ["all","male","female"] }, target_interests: { type: "array", items: { type: "string" } }, recommended_duration: { type: "string" }, image_prompt: { type: "string" }, summary: { type: "string" } }, required: ["title","body","cta_text","target_age_min","target_age_max","target_gender","recommended_duration","image_prompt","summary"], additionalProperties: false } } }],
    });
    const errResp = aiError(resp.status, cors);
    if (errResp) return errResp;
    if (!resp.ok) throw new Error("AI error");
    const data = await resp.json();
    const choice = data.choices?.[0];
    if (choice?.message?.tool_calls?.[0]?.function?.name === "generate_ad_campaign") {
      const adData = JSON.parse(choice.message.tool_calls[0].function.arguments);
      let imgUrl: string | null = null;
      if (adData.image_prompt) { const b64 = await generateAdImage(apiKey, adData.title, adData.image_prompt); if (b64) imgUrl = await uploadBase64ToStorage(b64); }
      return new Response(JSON.stringify({ type: "ad_generated", message: adData.summary, ad: { ...adData, generated_image_url: imgUrl } }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ type: "message", message: choice?.message?.content || "Reformulez svp." }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Legacy: generate_ad, moderate_ad, strategy
  const { product_name, product_description, target_audience, duration, budget, ad_title, ad_body } = body;
  let sys = "", usr = "";
  if (action === "generate_ad") { sys = "Expert marketing. JSON: title, body, cta_text, targeting_tips, estimated_reach."; usr = `Pub pour: ${product_name}. ${product_description || ""}. Audience: ${target_audience || "Large"}. Budget: ${budget || "?"}€.`; }
  else if (action === "moderate_ad") { sys = "Modérateur pub. JSON: approved, score, reasons, suggestions."; usr = `Titre: ${ad_title || product_name}. Texte: ${ad_body || product_description}.`; }
  else { sys = "Assistant marketing. JSON: recommended_duration, recommended_budget, reasoning, audience_segments."; usr = `${product_name}. ${product_description}. Budget: ${budget}€.`; }

  const resp = await callAI(apiKey, { model: "google/gemini-3-flash-preview", messages: [{ role: "system", content: sys }, { role: "user", content: usr }] });
  const errResp = aiError(resp.status, cors);
  if (errResp) return errResp;
  if (!resp.ok) throw new Error("AI error");
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "";
  let parsed; try { const m = content.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { raw: content }; } catch { parsed = { raw: content }; }
  return new Response(JSON.stringify(parsed), { headers: { ...cors, "Content-Type": "application/json" } });
}

// ── SELLER: generate_description, coach_chat ──
async function handleSeller(apiKey: string, body: any, userId: string, supabase: any, cors: Record<string, string>) {
  const { action } = body;

  if (action === "generate_description") {
    const resp = await callAI(apiKey, {
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: "Expert e-commerce. Génère une description produit optimisée en français. Max 200 mots. Emojis et bullet points. Hashtags à la fin." },
        { role: "user", content: `Produit: ${body.productInfo}. ${body.category ? `Catégorie: ${body.category}` : ""} ${body.price ? `Prix: ${body.price}€` : ""}` },
      ],
    });
    const errResp = aiError(resp.status, cors);
    if (errResp) return errResp;
    if (!resp.ok) throw new Error("AI error");
    // Stream response
    return new Response(resp.body, { headers: { ...cors, "Content-Type": "text/event-stream" } });
  }

  if (action === "coach_chat") {
    const { data: sp } = await supabase.from("seller_profiles").select("id").eq("user_id", userId).maybeSingle();
    if (!sp) return new Response(JSON.stringify({ error: "Profil vendeur introuvable" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
    const marketData = await fetchMarketData(supabase);
    const ctx = body.context || {};
    const products = (ctx.products || []).map((p: any, i: number) => `  ${i+1}. "${p.title}" - ${p.price}€`).join("\n");
    const resp = await callAI(apiKey, {
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: `Coach IA marketplace pour "${ctx.sellerName || "Vendeur"}". ${ctx.totalSales || 0} ventes, ${ctx.productCount || 0} produits.\nCatalogue:\n${products}\n${marketData}\nConseils concrets en français.` },
        ...(body.messages || []),
      ],
      stream: true,
    });
    const errResp = aiError(resp.status, cors);
    if (errResp) return errResp;
    if (!resp.ok) throw new Error("AI error");
    return new Response(resp.body, { headers: { ...cors, "Content-Type": "text/event-stream" } });
  }

  return new Response(JSON.stringify({ error: "Unknown seller action" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
}

// ── PHOTO GUARD: analyze_photo, compare_photos ──
async function handlePhotoGuard(apiKey: string, body: any, userId: string, supabase: any, cors: Record<string, string>) {
  const { action } = body;

  if (action === "analyze_photo") {
    const { imageUrl } = body;
    if (!imageUrl) return new Response(JSON.stringify({ error: "imageUrl requis" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const prompt = `Analyze this profile photo for fake/stolen signs: stock photo? celebrity? AI-generated? screenshot? Respond JSON: { risk_score: 0-100, is_suspicious: bool, reasons: [], recommendation: "approve"|"flag"|"reject", details: "..." }`;
    const resp = await callAI(apiKey, { model: "google/gemini-2.5-flash-lite", messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }] }], temperature: 0.1 });
    if (!resp.ok) throw new Error("AI error");
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const m = content.match(/\{[\s\S]*\}/);
    return new Response(JSON.stringify({ success: true, analysis: m ? JSON.parse(m[0]) : { risk_score: 0, is_suspicious: false, reasons: [], recommendation: "approve" } }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  if (action === "compare_photos") {
    const { data: myProfile } = await supabase.from("profiles").select("avatar_url").eq("user_id", userId).single();
    if (!myProfile?.avatar_url) return new Response(JSON.stringify({ success: true, has_duplicates: false, matches: [], summary: "Pas de photo" }), { headers: { ...cors, "Content-Type": "application/json" } });
    const { data: profiles } = await supabase.from("profiles").select("user_id,name,avatar_url").not("avatar_url", "is", null).neq("user_id", userId).order("created_at", { ascending: false }).limit(10);
    if (!profiles?.length) return new Response(JSON.stringify({ success: true, has_duplicates: false, matches: [], summary: "Pas assez de profils" }), { headers: { ...cors, "Content-Type": "application/json" } });
    const avatars = profiles.map((p: any) => p.avatar_url).filter(Boolean);
    const prompt = `First image is target. Check if SAME PERSON or SAME PHOTO in others. JSON: { has_duplicates: bool, matches: [{ image_index: n, confidence: 0-100, match_type: "same_photo"|"same_person"|"similar" }], summary: "..." }`;
    const resp = await callAI(apiKey, { model: "google/gemini-2.5-flash-lite", messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: myProfile.avatar_url } }, ...avatars.map((u: string) => ({ type: "image_url", image_url: { url: u } }))] }], temperature: 0.1 });
    if (!resp.ok) throw new Error("AI error");
    const data = await resp.json();
    const c = data.choices?.[0]?.message?.content || "{}";
    const m = c.match(/\{[\s\S]*\}/);
    const result = m ? JSON.parse(m[0]) : { has_duplicates: false, matches: [], summary: "Analyse impossible" };
    const enriched = (result.matches || []).map((mt: any) => ({ ...mt, matched_user: profiles[mt.image_index - 1] || null }));
    return new Response(JSON.stringify({ success: true, ...result, matches: enriched }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "Unknown photo action" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
}

// ── AGENT CHAT: Streaming agent conversation ──
const ACTION_SYSTEM_PROMPT = `\n\n## CAPACITÉS D'ACTION\nQuand l'utilisateur demande de publier ou créer du contenu, inclus un bloc d'action:\n\n\`\`\`forsure-action\n{"type": "publish_post", "body": "texte", "image_prompt": "description ou null"}\n\`\`\`\n\nTypes: publish_post, schedule_post (avec publish_at), create_story, generate_image.\nDate actuelle: ${new Date().toISOString()}\nUn seul bloc par message. Demande confirmation avant.`;

async function handleAgentChat(apiKey: string, body: any, userId: string, supabase: any, cors: Record<string, string>) {
  const { agent_id, conversation_id, message } = body;
  if (!agent_id || !message?.trim()) return new Response(JSON.stringify({ error: "agent_id et message requis" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  if (message.length > 5000) return new Response(JSON.stringify({ error: "Message trop long" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

  const { data: agent } = await supabase.from("ai_agents").select("*").eq("id", agent_id).eq("is_active", true).single();
  if (!agent) return new Response(JSON.stringify({ error: "Agent introuvable" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });

  const today = new Date().toISOString().split("T")[0];
  const { data: usage } = await supabase.from("ai_agent_usage").select("*").eq("user_id", userId).eq("agent_id", agent_id).eq("usage_date", today).maybeSingle();
  if ((usage?.message_count || 0) >= agent.free_messages_per_day) {
    return new Response(JSON.stringify({ error: "limit_reached", message: `Limite de ${agent.free_messages_per_day} messages/jour atteinte.`, is_premium: agent.is_premium }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
  }

  let convId = conversation_id;
  if (!convId) { const { data: conv } = await supabase.from("ai_agent_conversations").insert({ user_id: userId, agent_id, title: message.substring(0, 60) }).select("id").single(); convId = conv?.id; }
  await supabase.from("ai_agent_messages").insert({ conversation_id: convId, role: "user", content: message });
  const { data: history } = await supabase.from("ai_agent_messages").select("role, content").eq("conversation_id", convId).order("created_at", { ascending: true }).limit(20);

  const resp = await callAI(apiKey, { model: "google/gemini-3-flash-preview", messages: [{ role: "system", content: agent.system_prompt + ACTION_SYSTEM_PROMPT }, ...(history || []).map((m: any) => ({ role: m.role, content: m.content }))], stream: true });
  const errResp = aiError(resp.status, cors);
  if (errResp) return errResp;
  if (!resp.ok) throw new Error("AI error");

  if (usage) await supabase.from("ai_agent_usage").update({ message_count: (usage.message_count || 0) + 1 }).eq("id", usage.id);
  else await supabase.from("ai_agent_usage").insert({ user_id: userId, agent_id, usage_date: today, message_count: 1 });

  // Stream and save response
  const reader = resp.body!.getReader();
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
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data: ") || line === "data: [DONE]") {
            if (line === "data: [DONE]") { await supabase.from("ai_agent_messages").insert({ conversation_id: convId, role: "assistant", content: fullResponse }); controller.enqueue(encoder.encode(line + "\n\n")); }
            continue;
          }
          try { const p = JSON.parse(line.slice(6)); const c = p.choices?.[0]?.delta?.content; if (c) fullResponse += c; } catch {}
          controller.enqueue(encoder.encode(line + "\n\n"));
        }
      }
      if (fullResponse && !buffer.includes("[DONE]")) await supabase.from("ai_agent_messages").insert({ conversation_id: convId, role: "assistant", content: fullResponse });
      controller.close();
    },
  });

  return new Response(stream, { headers: { ...cors, "Content-Type": "text/event-stream", "X-Conversation-Id": convId } });
}

// ═══════════════════════════════════════════════════════════════
// ADMIN: Full platform intelligence & decision assistant
// Zeus v2 — Uses Gemini 2.5 Pro + tool calling for on-demand queries
// ═══════════════════════════════════════════════════════════════

// Tools Zeus can call to query data on-demand
const ZEUS_TOOLS = [
  {
    type: "function", function: {
      name: "search_users", description: "Rechercher des utilisateurs par nom, ville ou type de profil",
      parameters: { type: "object", properties: { query: { type: "string", description: "Nom ou ville à chercher" }, profile_type: { type: "string", enum: ["user", "creator", "business"], description: "Filtrer par type" } }, required: ["query"], additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "get_user_details", description: "Obtenir les détails complets d'un utilisateur (profil, trust score, signalements, commandes)",
      parameters: { type: "object", properties: { user_id: { type: "string", description: "UUID de l'utilisateur" } }, required: ["user_id"], additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "get_reports_by_type", description: "Lister les signalements filtrés par type et/ou statut",
      parameters: { type: "object", properties: { report_type: { type: "string", description: "Type: harassment, scam, spam, explicit, etc." }, status: { type: "string", enum: ["pending", "reviewed", "resolved", "dismissed"] } }, additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "get_revenue_analytics", description: "Obtenir les analytics de revenus avec ventilation par période",
      parameters: { type: "object", properties: { period: { type: "string", enum: ["today", "week", "month", "all"], description: "Période d'analyse" } }, required: ["period"], additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "get_marketplace_stats", description: "Statistiques marketplace : produits, vendeurs, catégories populaires",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "get_engagement_metrics", description: "Métriques d'engagement : likes, commentaires, lives, stories actives",
      parameters: { type: "object", properties: { period: { type: "string", enum: ["today", "week", "month"] } }, required: ["period"], additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "get_growth_metrics", description: "Métriques de croissance : nouveaux inscrits, rétention, churn",
      parameters: { type: "object", properties: { days: { type: "number", description: "Nombre de jours à analyser (7, 14, 30)" } }, required: ["days"], additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "simulate_platform_load", description: "Simuler la charge réseau pour estimer les capacités max : utilisateurs simultanés, lives concurrents, posts/min, messages/min, marketplace. Basé sur les données réelles + limites infra.",
      parameters: {
        type: "object",
        properties: {
          scenario: { type: "string", enum: ["current", "peak", "stress", "growth_10x", "growth_100x"], description: "Scénario de simulation" },
          focus: { type: "string", enum: ["all", "lives", "posts", "messages", "marketplace", "auth"], description: "Domaine à analyser en détail" },
        },
        required: ["scenario"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function", function: {
      name: "get_algorithm_config", description: "Lire la configuration actuelle de l'algorithme du feed (poids, récence, anti-spam, marketplace injection, etc.)",
      parameters: { type: "object", properties: { key: { type: "string", description: "Clé spécifique (scoring_weights, recency_tiers, time_of_day, velocity, marketplace_injection, anti_spam) ou vide pour tout" } }, additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "update_algorithm_config", description: "Modifier un paramètre de l'algorithme du feed. Change la valeur d'une clé de config. Exemples : augmenter friend_boost, réduire spam_penalty, changer les positions marketplace.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", enum: ["scoring_weights", "recency_tiers", "time_of_day", "velocity", "marketplace_injection", "anti_spam"], description: "Clé de config à modifier" },
          updates: { type: "object", description: "Objet partiel avec les champs à modifier (merge avec l'existant)" },
          reason: { type: "string", description: "Justification du changement pour le log" },
        },
        required: ["key", "updates", "reason"],
        additionalProperties: false,
      },
    },
  },
];

// Execute Zeus tool calls against the database
async function executeZeusTool(name: string, args: any, supabase: any): Promise<string> {
  try {
    switch (name) {
      case "search_users": {
        let q = supabase.from("profiles").select("user_id, name, avatar_url, city, profile_type, bio, created_at");
        if (args.query) q = q.ilike("name", `%${args.query}%`);
        if (args.profile_type) q = q.eq("profile_type", args.profile_type);
        const { data } = await q.limit(15);
        return JSON.stringify({ users: (data || []).map((u: any) => ({ ...u, user_id: u.user_id.slice(0, 12) + "..." })) });
      }
      case "get_user_details": {
        const uid = args.user_id;
        const [profileRes, trustRes, reportsRes, ordersRes, postsRes, friendsRes] = await Promise.all([
          supabase.from("profiles").select("*").eq("user_id", uid).maybeSingle(),
          supabase.from("trust_scores").select("*").eq("user_id", uid).maybeSingle(),
          supabase.from("abuse_reports").select("id, report_type, status, description, created_at").or(`reporter_id.eq.${uid},reported_user_id.eq.${uid}`).limit(10),
          supabase.from("orders").select("id, total, status, created_at").eq("buyer_id", uid).limit(10),
          supabase.from("posts").select("id, created_at", { count: "exact", head: true }).eq("user_id", uid),
          supabase.from("friendships").select("id", { count: "exact", head: true }).or(`requester_id.eq.${uid},addressee_id.eq.${uid}`).eq("status", "accepted"),
        ]);
        return JSON.stringify({
          profile: profileRes.data, trust: trustRes.data,
          reports_count: (reportsRes.data || []).length, reports: reportsRes.data,
          orders_count: (ordersRes.data || []).length, posts_count: postsRes.count || 0,
          friends_count: friendsRes.count || 0,
        });
      }
      case "get_reports_by_type": {
        let q = supabase.from("abuse_reports").select("id, reporter_id, reported_user_id, report_type, status, description, created_at").order("created_at", { ascending: false }).limit(25);
        if (args.report_type) q = q.eq("report_type", args.report_type);
        if (args.status) q = q.eq("status", args.status);
        const { data } = await q;
        return JSON.stringify({ reports: data || [], total: (data || []).length });
      }
      case "get_revenue_analytics": {
        const periodMap: Record<string, number> = { today: 1, week: 7, month: 30, all: 3650 };
        const days = periodMap[args.period] || 30;
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const [ordersRes, subsRes, tipsRes] = await Promise.all([
          supabase.from("orders").select("id, total, status, commission_amount, created_at").gte("created_at", since),
          supabase.from("creator_subscriptions").select("id, plan, status, price_cents, created_at").eq("status", "active"),
          supabase.from("tip_transactions").select("id, amount, created_at").gte("created_at", since),
        ]);
        const orders = (ordersRes.data || []).filter((o: any) => !["cancelled", "refunded"].includes(o.status));
        const revenue = orders.reduce((s: number, o: any) => s + (o.total || 0), 0);
        const commission = orders.reduce((s: number, o: any) => s + (o.commission_amount || 0), 0);
        const tips = (tipsRes.data || []).reduce((s: number, t: any) => s + (t.amount || 0), 0);
        const mrr = (subsRes.data || []).reduce((s: number, sub: any) => s + (sub.price_cents || 0), 0) / 100;
        return JSON.stringify({ period: args.period, orders_count: orders.length, revenue: revenue.toFixed(2), commission: commission.toFixed(2), tips: tips.toFixed(2), mrr: mrr.toFixed(2), active_subs: (subsRes.data || []).length });
      }
      case "get_marketplace_stats": {
        const [productsRes, sellersRes, ordersRes] = await Promise.all([
          supabase.from("products").select("id, category, price, stock_quantity, is_active, product_type"),
          supabase.from("seller_profiles").select("id, shop_name, is_verified, seller_type"),
          supabase.from("orders").select("id, status, total").limit(500),
        ]);
        const products = productsRes.data || [];
        const categories: Record<string, number> = {};
        products.forEach((p: any) => { categories[p.category || "autre"] = (categories[p.category || "autre"] || 0) + 1; });
        return JSON.stringify({
          total_products: products.length, active_products: products.filter((p: any) => p.is_active).length,
          total_sellers: (sellersRes.data || []).length, verified_sellers: (sellersRes.data || []).filter((s: any) => s.is_verified).length,
          categories, total_orders: (ordersRes.data || []).length,
          avg_price: products.length ? (products.reduce((s: number, p: any) => s + Number(p.price || 0), 0) / products.length).toFixed(2) : "0",
        });
      }
      case "get_engagement_metrics": {
        const days = args.period === "today" ? 1 : args.period === "week" ? 7 : 30;
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const [likesRes, commentsRes, postsRes, livesRes, storiesRes, messagesRes] = await Promise.all([
          supabase.from("likes").select("id", { count: "exact", head: true }).gte("created_at", since),
          supabase.from("comments").select("id", { count: "exact", head: true }).gte("created_at", since),
          supabase.from("posts").select("id", { count: "exact", head: true }).gte("created_at", since),
          supabase.from("live_streams").select("id, viewer_count, total_views").gte("created_at", since),
          supabase.from("stories").select("id", { count: "exact", head: true }).gte("created_at", since),
          supabase.from("messages").select("id", { count: "exact", head: true }).gte("created_at", since),
        ]);
        const lives = livesRes.data || [];
        return JSON.stringify({
          period: args.period, likes: likesRes.count || 0, comments: commentsRes.count || 0,
          posts: postsRes.count || 0, stories: storiesRes.count || 0, messages: messagesRes.count || 0,
          live_streams: lives.length, total_live_views: lives.reduce((s: number, l: any) => s + (l.total_views || 0), 0),
        });
      }
      case "get_growth_metrics": {
        const days = Math.min(args.days || 7, 90);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const prevSince = new Date(Date.now() - days * 2 * 86400000).toISOString();
        const [newUsersRes, prevUsersRes, totalUsersRes, deletionRes] = await Promise.all([
          supabase.from("profiles").select("id", { count: "exact", head: true }).gte("created_at", since),
          supabase.from("profiles").select("id", { count: "exact", head: true }).gte("created_at", prevSince).lt("created_at", since),
          supabase.from("profiles").select("id", { count: "exact", head: true }),
          supabase.from("account_deletion_requests").select("id", { count: "exact", head: true }).gte("created_at", since),
        ]);
        const newUsers = newUsersRes.count || 0;
        const prevUsers = prevUsersRes.count || 0;
        const growthRate = prevUsers > 0 ? (((newUsers - prevUsers) / prevUsers) * 100).toFixed(1) : "N/A";
        return JSON.stringify({
          days, new_users: newUsers, previous_period_users: prevUsers,
          growth_rate_percent: growthRate, total_users: totalUsersRes.count || 0,
          deletion_requests: deletionRes.count || 0,
        });
      }
      case "simulate_platform_load": {
        const scenario = args.scenario || "current";
        const focus = args.focus || "all";

        // Gather real baseline data
        const [totalUsersRes, activePostsRes, activeLivesRes, msgsHourRes, ordersHourRes, storiesRes] = await Promise.all([
          supabase.from("profiles").select("id", { count: "exact", head: true }),
          supabase.from("posts").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 86400000).toISOString()),
          supabase.from("live_streams").select("id, viewer_count, peak_viewer_count").eq("is_active", true),
          supabase.from("messages").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 3600000).toISOString()),
          supabase.from("orders").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 3600000).toISOString()),
          supabase.from("stories").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 86400000).toISOString()),
        ]);

        const totalUsers = totalUsersRes.count || 0;
        const postsToday = activePostsRes.count || 0;
        const activeLives = activeLivesRes.data || [];
        const msgsPerHour = msgsHourRes.count || 0;
        const ordersPerHour = ordersHourRes.count || 0;
        const storiesToday = storiesRes.count || 0;
        const currentViewers = activeLives.reduce((s: number, l: any) => s + (l.viewer_count || 0), 0);
        const peakViewers = activeLives.reduce((s: number, l: any) => s + (l.peak_viewer_count || 0), 0);

        // Infrastructure limits (Supabase Pro / Lovable Cloud)
        const infra = {
          db_connections_max: 60, // Supabase pooler
          db_rows_per_sec: 5000,
          realtime_connections_max: 500, // Supabase realtime
          edge_functions_concurrent: 100,
          storage_bandwidth_gb: 50, // per month
          api_requests_per_sec: 1000,
        };

        // Multipliers per scenario
        const multipliers: Record<string, number> = { current: 1, peak: 3, stress: 10, growth_10x: 10, growth_100x: 100 };
        const mult = multipliers[scenario] || 1;

        const simUsers = totalUsers * mult;
        const concurrentRate = scenario === "current" ? 0.05 : scenario === "peak" ? 0.15 : 0.25;
        const concurrent = Math.round(simUsers * concurrentRate);

        // Simulation results
        const sim = {
          scenario,
          focus,
          baseline: {
            total_users: totalUsers,
            posts_today: postsToday,
            stories_today: storiesToday,
            active_lives: activeLives.length,
            current_live_viewers: currentViewers,
            peak_live_viewers: peakViewers,
            messages_per_hour: msgsPerHour,
            orders_per_hour: ordersPerHour,
          },
          simulation: {
            simulated_users: simUsers,
            estimated_concurrent: concurrent,
            estimated_posts_per_min: Math.round((postsToday || 1) / 1440 * mult),
            estimated_messages_per_min: Math.round((msgsPerHour || 1) / 60 * mult),
            estimated_orders_per_hour: Math.round((ordersPerHour || 1) * mult),
            estimated_live_streams: Math.round((activeLives.length || 1) * mult),
            estimated_live_viewers: Math.round(Math.max(currentViewers, 1) * mult),
            estimated_stories_per_hour: Math.round((storiesToday || 1) / 24 * mult),
          },
          capacity: {
            db_connections: { used_estimate: Math.min(concurrent * 0.3, infra.db_connections_max * 2), max: infra.db_connections_max, status: concurrent * 0.3 > infra.db_connections_max ? "🔴 SATURÉ" : concurrent * 0.3 > infra.db_connections_max * 0.7 ? "🟡 ATTENTION" : "🟢 OK" },
            realtime: { used_estimate: Math.min(concurrent * 0.5, infra.realtime_connections_max * 2), max: infra.realtime_connections_max, status: concurrent * 0.5 > infra.realtime_connections_max ? "🔴 SATURÉ" : concurrent * 0.5 > infra.realtime_connections_max * 0.7 ? "🟡 ATTENTION" : "🟢 OK" },
            edge_functions: { concurrent_estimate: Math.round(concurrent * 0.1), max: infra.edge_functions_concurrent, status: concurrent * 0.1 > infra.edge_functions_concurrent ? "🔴 SATURÉ" : "🟢 OK" },
            api_throughput: { requests_per_sec_estimate: Math.round(concurrent * 0.5), max: infra.api_requests_per_sec, status: concurrent * 0.5 > infra.api_requests_per_sec ? "🔴 SATURÉ" : "🟢 OK" },
            live_streaming: {
              max_concurrent_streams: Math.min(Math.floor(infra.realtime_connections_max / 10), 50),
              max_viewers_per_stream: infra.realtime_connections_max > concurrent * 0.5 ? "illimité (dans la limite realtime)" : Math.floor(infra.realtime_connections_max / Math.max(activeLives.length, 1)),
              status: concurrent * 0.5 > infra.realtime_connections_max ? "🔴 GOULOT" : "🟢 OK",
            },
          },
          bottlenecks: [] as string[],
          recommendations: [] as string[],
          max_theoretical: {
            max_concurrent_users: Math.min(infra.realtime_connections_max, infra.db_connections_max * 3, infra.api_requests_per_sec * 2),
            max_simultaneous_lives: Math.floor(infra.realtime_connections_max / 10),
            max_posts_per_minute: Math.floor(infra.db_rows_per_sec * 60 * 0.1),
            max_messages_per_minute: Math.floor(infra.db_rows_per_sec * 60 * 0.2),
            max_orders_per_hour: Math.floor(infra.edge_functions_concurrent * 3600 * 0.01),
          },
        };

        // Detect bottlenecks
        if (sim.capacity.db_connections.status.includes("SATURÉ")) sim.bottlenecks.push("🗄️ Connexions DB saturées — upgrade pool ou passer en mode serverless");
        if (sim.capacity.realtime.status.includes("SATURÉ")) sim.bottlenecks.push("📡 Realtime saturé — limiter les subscriptions ou upgrade plan");
        if (sim.capacity.edge_functions.status.includes("SATURÉ")) sim.bottlenecks.push("⚡ Edge Functions saturées — ajouter cache / réduire appels IA");
        if (sim.capacity.api_throughput.status.includes("SATURÉ")) sim.bottlenecks.push("🌐 API rate limit atteint — CDN, cache, ou throttle côté client");
        if (sim.capacity.live_streaming.status.includes("GOULOT")) sim.bottlenecks.push("🎥 Live streaming limité par realtime — considérer LiveKit dédié");

        if (sim.bottlenecks.length === 0) sim.bottlenecks.push("✅ Aucun goulot détecté pour ce scénario");

        // Recommendations
        if (scenario === "growth_10x" || scenario === "growth_100x") {
          sim.recommendations.push("📈 Passer à Supabase Pro/Enterprise pour plus de connexions DB");
          sim.recommendations.push("🔄 Implémenter un CDN (Cloudflare) devant les assets");
          sim.recommendations.push("💾 Ajouter Redis/Upstash pour le cache des requêtes fréquentes");
          sim.recommendations.push("🎬 Migrer les lives vers un service dédié (LiveKit Cloud / Mux)");
        }
        if (scenario === "stress") {
          sim.recommendations.push("🛡️ Activer le rate limiting agressif côté API Gateway");
          sim.recommendations.push("📊 Monitorer avec Grafana + Prometheus");
        }
        if (concurrent > 200) {
          sim.recommendations.push("🔧 Optimiser les requêtes N+1 (utiliser des vues matérialisées)");
          sim.recommendations.push("🧩 Séparer les lectures/écritures avec des réplicas read-only");
        }

        return JSON.stringify(sim);
      }
      case "get_algorithm_config": {
        let q = supabase.from("feed_algorithm_config").select("key, value, description, updated_at");
        if (args.key) q = q.eq("key", args.key);
        const { data, error } = await q;
        if (error) return JSON.stringify({ error: error.message });
        return JSON.stringify({ config: data || [] });
      }
      case "update_algorithm_config": {
        // Read current value
        const { data: current, error: readErr } = await supabase
          .from("feed_algorithm_config")
          .select("value")
          .eq("key", args.key)
          .maybeSingle();
        if (readErr || !current) return JSON.stringify({ error: `Config "${args.key}" introuvable` });

        // Merge updates
        const merged = { ...current.value, ...args.updates };
        const { error: updateErr } = await supabase
          .from("feed_algorithm_config")
          .update({ value: merged, updated_at: new Date().toISOString() })
          .eq("key", args.key);
        if (updateErr) return JSON.stringify({ error: updateErr.message });

        return JSON.stringify({
          success: true,
          key: args.key,
          reason: args.reason,
          previous: current.value,
          new_value: merged,
          changed_fields: Object.keys(args.updates),
        });
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: `Tool error: ${(e as Error).message}` });
  }
}

async function handleAdmin(apiKey: string, body: any, userId: string, supabase: any, cors: Record<string, string>) {
  // Verify admin role
  const { data: roleData } = await supabase.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (!roleData) return new Response(JSON.stringify({ error: "Accès admin requis" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });

  const { action } = body;

  // Handle apply_proposal action (admin validated a Zeus proposal)
  if (action === 'apply_proposal') {
    const { proposalAction, key, updates, reason } = body;
    const normalizedProposalAction = String(proposalAction || "")
      .split("|")[0]
      .replace(/[`\s]/g, "")
      .replace(/\.$/, "");
    if (normalizedProposalAction === 'update_algorithm_config' && key && updates) {
      const { data: current } = await supabase.from("feed_algorithm_config").select("value").eq("key", key).maybeSingle();
      if (!current) return new Response(JSON.stringify({ error: `Config "${key}" introuvable` }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      const merged = { ...current.value, ...updates };
      const { error } = await supabase.from("feed_algorithm_config").update({ value: merged, updated_at: new Date().toISOString(), updated_by: userId }).eq("key", key);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ success: true, key, reason, new_value: merged }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Action non supportée", proposalAction, normalizedProposalAction, key: !!key, updates: !!updates }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  if (action === "chat") {
    // Gather core platform snapshot (lightweight — details fetched via tools)
    const [usersRes, postsRes, ordersRes, reportsRes, bansRes, trustRes, subsRes, verificationsRes, livesRes, productsRes] = await Promise.all([
      supabase.from("profiles").select("user_id, name, city, profile_type, created_at", { count: "exact" }).order("created_at", { ascending: false }).limit(10),
      supabase.from("posts").select("id", { count: "exact", head: true }),
      supabase.from("orders").select("id, total, status, created_at"),
      supabase.from("abuse_reports").select("id, report_type, status, description, created_at").order("created_at", { ascending: false }).limit(20),
      supabase.from("banned_users").select("id", { count: "exact", head: true }).eq("is_active", true),
      supabase.from("trust_scores").select("user_id, trust_score, is_flagged, flag_reason").eq("is_flagged", true).limit(10),
      supabase.from("creator_subscriptions").select("id, plan, status, price_cents"),
      supabase.from("identity_verifications").select("id, status, reason, created_at").eq("status", "pending").limit(10),
      supabase.from("live_streams").select("id", { count: "exact", head: true }).eq("is_active", true),
      supabase.from("products").select("id", { count: "exact", head: true }).eq("is_active", true),
    ]);

    const orders = ordersRes.data || [];
    const totalRevenue = orders.filter((o: any) => o.status !== "cancelled" && o.status !== "refunded").reduce((s: number, o: any) => s + (o.total || 0), 0);
    const pendingReports = (reportsRes.data || []).filter((r: any) => r.status === "pending");
    const activeSubs = (subsRes.data || []).filter((s: any) => s.status === "active");
    const monthlyMRR = activeSubs.reduce((s: number, sub: any) => s + (sub.price_cents || 0), 0) / 100;
    const flaggedProfiles = trustRes.data || [];

    // Compute daily new users (last 7 days)
    const last7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const { count: newUsersWeek } = await supabase.from("profiles").select("id", { count: "exact", head: true }).gte("created_at", last7d);

    const platformContext = `
## 📊 SNAPSHOT PLATEFORME (${new Date().toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" })})

| Métrique | Valeur |
|---|---|
| 👥 Utilisateurs | ${usersRes.count || 0} |
| 📝 Publications | ${postsRes.count || 0} |
| 🛍️ Produits actifs | ${productsRes.count || 0} |
| 📦 Commandes | ${orders.length} |
| 💰 Revenus total | ${totalRevenue.toFixed(2)}€ |
| 💳 MRR abonnements | ${monthlyMRR.toFixed(2)}€ (${activeSubs.length} actifs) |
| 🚨 Signalements en attente | ${pendingReports.length} |
| 🛡️ Vérifications ID en attente | ${(verificationsRes.data || []).length} |
| 🚫 Utilisateurs bannis | ${bansRes.count || 0} |
| ⚠️ Profils flaggés | ${flaggedProfiles.length} |
| 📡 Lives actifs | ${livesRes.count || 0} |
| 📈 Nouveaux inscrits (7j) | ${newUsersWeek || 0} |

### 🚨 Signalements en attente (top 5) :
${pendingReports.slice(0, 5).map((r: any) => `- **[${r.report_type}]** ${r.description || "Sans description"} _(${new Date(r.created_at).toLocaleDateString("fr")})_`).join("\n") || "✅ Aucun signalement en attente"}

### ⚠️ Profils à risque :
${flaggedProfiles.slice(0, 5).map((t: any) => `- \`${t.user_id.slice(0, 8)}…\` — Trust: **${t.trust_score}**/100 — ${t.flag_reason}`).join("\n") || "✅ Aucun profil flaggé"}

### 👋 Derniers inscrits :
${(usersRes.data || []).slice(0, 5).map((u: any) => `- **${u.name}** (${u.city || "—"}) — ${u.profile_type || "user"} — ${new Date(u.created_at).toLocaleDateString("fr")}`).join("\n")}

### 🔐 Vérifications ID en attente :
${(verificationsRes.data || []).slice(0, 5).map((v: any) => `- ${v.reason || "Pas de raison"} _(${new Date(v.created_at).toLocaleDateString("fr")})_`).join("\n") || "✅ Aucune"}
`;

    const systemPrompt = `Tu es **ZEUS**, le cerveau stratégique de la plateforme **ForSure** — un réseau social complet avec marketplace, lives, messagerie, agents IA, et système de confiance.

## 🧠 PERSONNALITÉ
Tu es un directeur stratégique virtuel : analytique, **proactif**, pragmatique. Tu anticipes les problèmes avant qu'ils n'arrivent. Tu fournis des analyses dignes d'un board de direction.

## 🔑 COMPORTEMENT PROACTIF (TRÈS IMPORTANT)
**Tu es un vrai assistant stratégique. Tu ne te contentes PAS de répondre aux questions. Tu DOIS :**
1. **À chaque conversation**, analyser les données automatiquement (appeler tes outils) et **proposer des améliorations concrètes** sans qu'on te le demande
2. **Terminer CHAQUE réponse** par une section "## 💡 Propositions Zeus" avec 1 à 3 actions concrètes que tu recommandes
3. **Pour chaque proposition qui modifie un paramètre**, utiliser le format exact suivant pour que l'admin puisse valider :

\`\`\`
[ZEUS_PROPOSAL]
action: update_algorithm_config | ban_user | flag_profile | ...
key: scoring_weights
updates: {"friend_boost": 12, "discovery_boost": 20}
reason: Augmenter la découverte car l'engagement est faible cette semaine
[/ZEUS_PROPOSAL]
\`\`\`

4. **NE JAMAIS appliquer update_algorithm_config directement** — tu PROPOSES toujours et l'admin valide avec le bouton. Tu peux par contre LIRE les configs librement.
5. **Être conversationnel** : parle comme un collègue stratégique, donne ton avis, alerte sur les problèmes, suggère des expérimentations
6. **Chaque fois que tu détectes une anomalie** (engagement en baisse, spam en hausse, etc.), propose immédiatement un ajustement avec le format [ZEUS_PROPOSAL]

## 🎯 CAPACITÉS
1. **Analyse de données** : Tu vois les métriques en temps réel et peux interroger la base via tes outils
2. **Détection de risques** : Sécurité, abus, fraude, bots, usurpation d'identité
3. **Recommandations stratégiques** : Croissance, rétention, monétisation, engagement
4. **Aide à la décision** : Tu argumentes chaque recommandation avec des données factuelles
5. **Audit** : Tu peux analyser un utilisateur, un signalement ou un pattern de comportement
6. **Tuning algorithme** : Tu proposes des modifications de l'algorithme du feed, marketplace, anti-spam

## 📐 FORMAT DE RÉPONSE
- Structure tes réponses avec des titres ##, des tableaux markdown, des listes
- Utilise des emojis pour la lisibilité (📊 📈 🚨 ✅ ❌ 💡 ⚡ 🎯)
- Fournis toujours un "## 💡 Propositions Zeus" à la fin
- Quantifie tes analyses (%, chiffres, tendances)
- Sois **concis mais complet** — max 400 mots sauf analyse détaillée demandée
- Sois **proactif** : ne te contente pas de répondre, propose !

## 🔒 RÈGLES STRICTES
- JAMAIS inventer de données — utilise tes outils pour vérifier
- **JAMAIS appliquer un changement sans validation** — toujours utiliser [ZEUS_PROPOSAL]
- Prioriser la sécurité des mineurs (tolérance zéro)
- Signaler les anomalies statistiques (pics, chutes, patterns suspects)
- Si tu ne sais pas, dis-le et propose d'investiguer via tes outils

## 🛠️ OUTILS DISPONIBLES
Tu peux appeler des outils pour interroger la base en temps réel :
- \`search_users\` : Chercher des utilisateurs
- \`get_user_details\` : Détails complets d'un profil
- \`get_reports_by_type\` : Filtrer les signalements
- \`get_revenue_analytics\` : Analytics revenus par période
- \`get_marketplace_stats\` : Stats marketplace
- \`get_engagement_metrics\` : Métriques d'engagement
- \`get_growth_metrics\` : Croissance et rétention
- \`simulate_platform_load\` : Simulation de charge réseau
- \`get_algorithm_config\` : Lire la config de l'algorithme du feed (LECTURE LIBRE)
- \`update_algorithm_config\` : ⚠️ **NE PAS UTILISER DIRECTEMENT** — propose via [ZEUS_PROPOSAL] à la place

## 🧬 ALGORITHME DU FEED
Tu peux lire la config avec \`get_algorithm_config\`. Les clés sont :
- \`scoring_weights\` : friend_boost, discovery_boost, image_boost, engagement_cap, spam_penalty_factor, etc.
- \`recency_tiers\` : paliers de récence (1h, 3h, 6h, 12h, 24h, 48h)
- \`time_of_day\` : multiplicateurs par tranche horaire
- \`velocity\` : détection de contenu trending
- \`marketplace_injection\` : positions d'injection et nombre de produits
- \`anti_spam\` : pénalités anti-spam

**Workflow obligatoire :**
1. Lis la config avec \`get_algorithm_config\`
2. Analyse les métriques avec \`get_engagement_metrics\` et \`get_growth_metrics\`
3. Propose des modifications via [ZEUS_PROPOSAL] dans ta réponse
4. L'admin valide ou refuse via les boutons dans l'interface

Utilise tes outils activement et systématiquement pour enrichir tes analyses. Sois proactif !

${platformContext}

Date et heure : ${new Date().toLocaleString("fr-FR")}`;


    // Multi-turn tool-calling loop
    const messages = [{ role: "system", content: systemPrompt }, ...(body.messages || [])];
    
    // First call — may trigger tool use
    let resp = await callAI(apiKey, {
      model: "google/gemini-3.1-pro-preview",
      messages,
      tools: ZEUS_TOOLS,
      stream: false,
    });
    let errResp = aiError(resp.status, cors);
    if (errResp) return errResp;
    if (!resp.ok) throw new Error("AI error");

    let aiData = await resp.json();
    let choice = aiData.choices?.[0];
    let toolCalls = choice?.message?.tool_calls;
    let loopCount = 0;
    const maxLoops = 5;

    // Tool-calling loop: execute tools and feed results back
    while (toolCalls?.length && loopCount < maxLoops) {
      loopCount++;
      messages.push(choice.message);
      
      // Execute all tool calls in parallel
      const toolResults = await Promise.all(
        toolCalls.map(async (tc: any) => {
          const args = JSON.parse(tc.function.arguments || "{}");
          const result = await executeZeusTool(tc.function.name, args, supabase);
          return { role: "tool", tool_call_id: tc.id, content: result };
        })
      );
      messages.push(...toolResults);

      // Call AI again with tool results
      resp = await callAI(apiKey, { model: "google/gemini-3.1-pro-preview", messages, tools: ZEUS_TOOLS, stream: false });
      errResp = aiError(resp.status, cors);
      if (errResp) return errResp;
      if (!resp.ok) throw new Error("AI error");
      aiData = await resp.json();
      choice = aiData.choices?.[0];
      toolCalls = choice?.message?.tool_calls;
    }

    // Final response — stream it if it's text
    const finalContent = choice?.message?.content || "Je n'ai pas pu générer de réponse.";
    
    // Stream the final response for better UX
    const streamResp = await callAI(apiKey, {
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "Tu es ZEUS. Reproduis exactement le contenu suivant sans rien modifier, ajouter ou retrancher. Garde le formatage markdown identique." },
        { role: "user", content: finalContent },
      ],
      stream: true,
    });
    if (!streamResp.ok) {
      // Fallback: return as JSON
      return new Response(JSON.stringify({ result: finalContent }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(streamResp.body, { headers: { ...cors, "Content-Type": "text/event-stream" } });
  }

  if (action === "stats") {
    const [usersRes, postsRes, ordersRes, reportsRes, bansRes, subsRes] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("posts").select("id", { count: "exact", head: true }),
      supabase.from("orders").select("id, total, status"),
      supabase.from("abuse_reports").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("banned_users").select("id", { count: "exact", head: true }).eq("is_active", true),
      supabase.from("creator_subscriptions").select("id, price_cents, status").eq("status", "active"),
    ]);
    const orders = ordersRes.data || [];
    const revenue = orders.filter((o: any) => o.status !== "cancelled").reduce((s: number, o: any) => s + (o.total || 0), 0);
    const mrr = (subsRes.data || []).reduce((s: number, sub: any) => s + (sub.price_cents || 0), 0) / 100;
    return new Response(JSON.stringify({
      users: usersRes.count || 0, posts: postsRes.count || 0,
      orders: orders.length, revenue: revenue.toFixed(2),
      pendingReports: reportsRes.count || 0, activeBans: bansRes.count || 0,
      activeSubscriptions: (subsRes.data || []).length, mrr: mrr.toFixed(2),
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  if (action === "search_users") {
    const { query } = body;
    if (!query) return new Response(JSON.stringify({ error: "query required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const { data } = await supabase.from("profiles").select("user_id, name, avatar_url, city, profile_type, created_at").ilike("name", `%${query}%`).limit(20);
    return new Response(JSON.stringify({ users: data || [] }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "Unknown admin action" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
}

// ═══════════════════════════════════════════════════════════════
// BASIC MODERATION FALLBACKS
// ═══════════════════════════════════════════════════════════════
function basicModeration(text: string): { safe: boolean; reason: string | null; category: string } {
  const lower = text.toLowerCase();
  const scam = [/gagn(ez|er)\s+\d+\s*€/i, /cliquez?\s+ici\s+pour\s+gagner/i, /envoyez?\s+(moi\s+)?(votre|ton)\s+(numéro|carte|code|mot\s+de\s+passe)/i, /bitcoin|crypto\s+gratuit/i, /bit\.ly|tinyurl/i];
  for (const p of scam) if (p.test(lower)) return { safe: false, reason: "Arnaque détectée", category: "scam" };
  if (/(.)\1{10,}/.test(text) || /(https?:\/\/[^\s]+\s*){4,}/i.test(text)) return { safe: false, reason: "Spam", category: "spam" };
  return { safe: true, reason: null, category: "safe" };
}

function basicMinorModeration(text: string): { safe: boolean; reason: string | null; category: string } {
  const basic = basicModeration(text);
  if (!basic.safe) return basic;
  const lower = text.toLowerCase();
  const grooming = [/t'es\s+(trop\s+)?(belle|beau|mignon|sexy|jolie|canon)/i, /envoie\s+(moi\s+)?(une|ta|des)\s+(photo|image|selfie)/i, /dis\s+(pas|rien)\s+(à|aux)\s+(tes\s+)?(parents|père|mère)/i, /notre\s+secret/i, /on\s+peut\s+(se\s+)?(voir|rencontrer)/i, /tu\s+habites?\s+(où|ou)/i, /quel(le)?\s+(âge|école|collège|lycée)/i, /(ton|ta)\s+(numéro|tel|snap|whatsapp|insta)/i];
  for (const p of grooming) if (p.test(lower)) return { safe: false, reason: "Message suspect envers mineur", category: "grooming" };
  const isolation = [/ne\s+(dis|parle)\s+(rien|pas)\s+(à|aux)/i, /viens\s+(sur|en)\s+(privé|dm|mp)/i];
  for (const p of isolation) if (p.test(lower)) return { safe: false, reason: "Tentative d'isolement", category: "isolation" };
  return { safe: true, reason: null, category: "safe" };
}

// ═══════════════════════════════════════════════════════════════
// MAIN ROUTER
// ═══════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const body = await req.json();
    const { domain, action } = body;

    if (!domain || !action) {
      return new Response(JSON.stringify({ error: "⚡ Zeus requires 'domain' and 'action' parameters. Domains: content, post, moderation, ads, seller, photo, agent" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Rate limit per domain
    const limitMap: Record<string, number> = { content: 20, post: 15, moderation: 30, ads: 10, seller: 10, photo: 5, agent: 20, admin: 30 };
    if (!checkRateLimit(`${user.id}:${domain}`, limitMap[domain] || 15)) {
      return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez." }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
    }

    switch (domain) {
      case "content": return await handleContent(LOVABLE_API_KEY, body, cors);
      case "post": return await handlePostAssistant(LOVABLE_API_KEY, body, cors);
      case "moderation": return await handleModeration(LOVABLE_API_KEY, body, user.id, supabase, cors);
      case "ads": return await handleAds(LOVABLE_API_KEY, body, cors);
      case "seller": return await handleSeller(LOVABLE_API_KEY, body, user.id, supabase, cors);
      case "photo": return await handlePhotoGuard(LOVABLE_API_KEY, body, user.id, supabase, cors);
      case "agent": return await handleAgentChat(LOVABLE_API_KEY, body, user.id, supabase, cors);
      case "admin": return await handleAdmin(LOVABLE_API_KEY, body, user.id, supabase, cors);
      default:
        return new Response(JSON.stringify({ error: `Unknown domain: ${domain}` }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
  } catch (err) {
    console.error("⚡ Zeus error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
