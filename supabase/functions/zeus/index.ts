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
// ═══════════════════════════════════════════════════════════════
async function handleAdmin(apiKey: string, body: any, userId: string, supabase: any, cors: Record<string, string>) {
  // Verify admin role
  const { data: roleData } = await supabase.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (!roleData) return new Response(JSON.stringify({ error: "Accès admin requis" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });

  const { action } = body;

  if (action === "chat") {
    // Gather full platform context
    const [usersRes, postsRes, ordersRes, reportsRes, agentsRes, bansRes, trustRes, subsRes, verificationsRes] = await Promise.all([
      supabase.from("profiles").select("user_id, name, city, profile_type, created_at", { count: "exact" }).order("created_at", { ascending: false }).limit(20),
      supabase.from("posts").select("id, body, created_at, user_id", { count: "exact" }).order("created_at", { ascending: false }).limit(10),
      supabase.from("orders").select("id, total, status, created_at"),
      supabase.from("abuse_reports").select("id, report_type, status, description, created_at").order("created_at", { ascending: false }).limit(20),
      supabase.from("ai_agent_usage").select("agent_id, message_count, usage_date").gte("usage_date", new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0]),
      supabase.from("banned_users").select("id, user_id, reason, banned_at").eq("is_active", true),
      supabase.from("trust_scores").select("user_id, trust_score, is_flagged, flag_reason").eq("is_flagged", true).limit(10),
      supabase.from("creator_subscriptions").select("id, plan, status, price_cents"),
      supabase.from("identity_verifications").select("id, status, reason, created_at").eq("status", "pending").limit(10),
    ]);

    const orders = ordersRes.data || [];
    const totalRevenue = orders.filter((o: any) => o.status !== "cancelled" && o.status !== "refunded").reduce((s: number, o: any) => s + (o.total || 0), 0);
    const pendingReports = (reportsRes.data || []).filter((r: any) => r.status === "pending");
    const agentMessages7d = (agentsRes.data || []).reduce((s: number, u: any) => s + (u.message_count || 0), 0);
    const activeSubs = (subsRes.data || []).filter((s: any) => s.status === "active");
    const monthlyMRR = activeSubs.reduce((s: number, sub: any) => s + (sub.price_cents || 0), 0) / 100;

    const platformContext = `
## DONNÉES PLATEFORME EN TEMPS RÉEL
- **Utilisateurs total** : ${usersRes.count || 0}
- **Publications total** : ${postsRes.count || 0}
- **Commandes total** : ${orders.length} | Revenus : ${totalRevenue.toFixed(2)}€
- **MRR abonnements** : ${monthlyMRR.toFixed(2)}€ (${activeSubs.length} actifs)
- **Signalements en attente** : ${pendingReports.length}
- **Vérifications ID en attente** : ${(verificationsRes.data || []).length}
- **Utilisateurs bannis actifs** : ${(bansRes.data || []).length}
- **Profils flaggés (trust)** : ${(trustRes.data || []).length}
- **Messages IA (7j)** : ${agentMessages7d}

### Signalements récents en attente :
${pendingReports.slice(0, 5).map((r: any) => `- [${r.report_type}] ${r.description || "Pas de description"} (${new Date(r.created_at).toLocaleDateString("fr")})`).join("\n") || "Aucun"}

### Profils flaggés :
${(trustRes.data || []).slice(0, 5).map((t: any) => `- User ${t.user_id.slice(0, 8)}... : score ${t.trust_score}, raison: ${t.flag_reason}`).join("\n") || "Aucun"}

### Derniers inscrits :
${(usersRes.data || []).slice(0, 5).map((u: any) => `- ${u.name} (${u.city || "?"}) — ${u.profile_type || "user"} — ${new Date(u.created_at).toLocaleDateString("fr")}`).join("\n")}

### Vérifications ID en attente :
${(verificationsRes.data || []).slice(0, 5).map((v: any) => `- Raison: ${v.reason || "?"} (${new Date(v.created_at).toLocaleDateString("fr")})`).join("\n") || "Aucune"}
`;

    const systemPrompt = `Tu es ZEUS, l'assistant IA de décision de la plateforme ForSure. Tu as accès à TOUTES les données en temps réel.

RÔLE :
- Analyser les données et tendances de la plateforme
- Proposer des recommandations stratégiques argumentées
- Alerter sur les risques (sécurité, abus, fraude)
- Aider à prendre des décisions admin éclairées
- Répondre en français, de manière concise et structurée avec des tableaux markdown

RÈGLES :
- Toujours baser tes analyses sur les données réelles fournies
- Prioriser la sécurité des utilisateurs (surtout mineurs)
- Proposer des actions concrètes quand pertinent
- Utiliser des emojis pour la lisibilité
- Ne JAMAIS inventer de données

${platformContext}`;

    const resp = await callAI(apiKey, {
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: systemPrompt },
        ...(body.messages || []),
      ],
      stream: true,
    });
    const errResp = aiError(resp.status, cors);
    if (errResp) return errResp;
    if (!resp.ok) throw new Error("AI error");
    return new Response(resp.body, { headers: { ...cors, "Content-Type": "text/event-stream" } });
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
    const limitMap: Record<string, number> = { content: 20, post: 15, moderation: 30, ads: 10, seller: 10, photo: 5, agent: 20 };
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
      default:
        return new Response(JSON.stringify({ error: `Unknown domain: ${domain}` }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
  } catch (err) {
    console.error("⚡ Zeus error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
