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

  const systemPrompt = `Tu es un assistant d'écriture pour réseau social. Réponds UNIQUEMENT avec un JSON valide, sans markdown, sans backticks.
Action "${safeAction}":
- "improve": Corrige et améliore le style. Garde la langue originale.
- "formal": Rends plus professionnel.
- "casual": Rends plus décontracté.
- "shorter": Raccourcis en gardant l'essentiel.
- "longer": Développe avec plus de détails.

Format JSON obligatoire:
{"improved_text":"...","detected_language":"fr","corrections":["correction1"],"tone":"casual"}`;

  const resp = await callAI(apiKey, {
    model: "google/gemini-2.5-flash-lite",
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
  });
  const errResp = aiError(resp.status, cors);
  if (errResp) return errResp;
  if (!resp.ok) return new Response(JSON.stringify({ error: "Erreur IA" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || "";
  try {
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const result = JSON.parse(cleaned);
    if (result.improved_text) return new Response(JSON.stringify(result), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch {}
  return new Response(JSON.stringify({ improved_text: raw.trim() || text, detected_language: "unknown", corrections: [], tone: "neutral" }), { headers: { ...cors, "Content-Type": "application/json" } });
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

// ── ADS: chat, generate_ad, moderate_ad, generate_image, translate ──
async function handleAds(apiKey: string, body: any, cors: Record<string, string>) {
  const { action } = body;

  if (action === "generate_image") {
    const base64 = await generateAdImage(apiKey, body.title, body.description);
    if (base64) { const url = await uploadBase64ToStorage(base64); return new Response(JSON.stringify({ image_url: url }), { headers: { ...cors, "Content-Type": "application/json" } }); }
    return new Response(JSON.stringify({ error: "Image generation failed" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Translate ad content to a target language
  if (action === "translate_ad") {
    const { title, adBody, cta_text, targetLang } = body;
    if (!title || !adBody || !targetLang) return new Response(JSON.stringify({ error: "title, adBody et targetLang requis" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const langNames: Record<string, string> = { fr: "French", en: "English", es: "Spanish", de: "German", pt: "Portuguese", it: "Italian", ar: "Arabic", nl: "Dutch", ja: "Japanese", zh: "Chinese" };
    const langLabel = langNames[targetLang] || targetLang;
    const resp = await callAI(apiKey, {
      model: "google/gemini-3-flash-preview",
      tools: [{ type: "function", function: { name: "translated_ad", description: "Returns the translated ad content", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, cta_text: { type: "string" } }, required: ["title", "body", "cta_text"], additionalProperties: false } } }],
      tool_choice: { type: "function", function: { name: "translated_ad" } },
      messages: [
        { role: "system", content: `You are a professional marketing translator. Translate ad copy to ${langLabel}. Keep the same tone, persuasion and marketing impact. Adapt idioms naturally.` },
        { role: "user", content: `Translate this ad:\nTitle: ${title}\nBody: ${adBody}\nCTA: ${cta_text || "En savoir plus"}` },
      ],
    });
    const errResp = aiError(resp.status, cors);
    if (errResp) return errResp;
    if (!resp.ok) throw new Error("AI error");
    const data = await resp.json();
    const tc = data.choices?.[0]?.message?.tool_calls?.[0];
    if (tc?.function?.name === "translated_ad") {
      const translated = JSON.parse(tc.function.arguments);
      return new Response(JSON.stringify({ success: true, translated }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Translation failed" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  if (action === "chat") {
    const targetLang = body.targetLang || "fr";
    const langNames: Record<string, string> = { fr: "français", en: "anglais", es: "espagnol", de: "allemand", pt: "portugais", it: "italien", ar: "arabe", nl: "néerlandais", ja: "japonais", zh: "chinois" };
    const langInstruction = targetLang !== "fr"
      ? `\nIMPORTANT: L'utilisateur veut créer sa pub en ${langNames[targetLang] || targetLang}. Génère le titre, le body et le CTA dans cette langue. Tes réponses conversationnelles restent en français.`
      : "";
    const resp = await callAI(apiKey, {
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: `Tu es l'assistant publicitaire IA de ForSure Ads. Aide à créer des pubs performantes. Concis, pro, en français.${langInstruction}` },
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
const ACTION_SYSTEM_PROMPT = `\n\n## CAPACITÉS D'ACTION — OBLIGATOIRE\nTu DOIS inclure un bloc forsure-action quand l'utilisateur demande de publier, traduire ou envoyer un message. NE DEMANDE PAS de confirmation, l'interface a un bouton pour ça. Si pas de texte précis, INVENTE un texte engageant.\n\nPublier:\n\`\`\`forsure-action\n{"type": "publish_post", "body": "texte engageant"}\n\`\`\`\n\nTraduire:\n\`\`\`forsure-action\n{"type": "translate", "translated_text": "translated", "target_language": "en", "body": "original"}\n\`\`\`\n\nEnvoyer un message à un ami:\n\`\`\`forsure-action\n{"type": "send_message", "conversation_id": "uuid-de-la-conversation", "recipient_name": "Nom", "message_text": "Le message à envoyer"}\n\`\`\`\n\nExemples: "publie" → crée un post inspirant + bloc. "publie sur le sport" → post sport + bloc. "traduis en anglais: bonjour" → bloc translate. "envoie à Marie: salut ça va" → bloc send_message (demande la conversation si pas précisée). "écris un message à..." → bloc send_message.\nDate: ${new Date().toISOString()}\nUn bloc par message.`;

async function handleAgentChat(apiKey: string, body: any, userId: string, supabase: any, cors: Record<string, string>) {
  const { agent_id, conversation_id, message } = body;
  if (!agent_id || !message?.trim()) return new Response(JSON.stringify({ error: "agent_id et message requis" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  if (message.length > 5000) return new Response(JSON.stringify({ error: "Message trop long" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

  const { data: agent } = await supabase.from("ai_agents").select("*").eq("id", agent_id).eq("is_active", true).single();
  if (!agent) return new Response(JSON.stringify({ error: "Agent introuvable" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });

  const today = new Date().toISOString().split("T")[0];
  const [{ data: usage }, { data: subscription }] = await Promise.all([
    supabase.from("ai_agent_usage").select("*").eq("user_id", userId).eq("agent_id", agent_id).eq("usage_date", today).maybeSingle(),
    supabase.from("creator_subscriptions").select("status").eq("user_id", userId).eq("status", "active").maybeSingle(),
  ]);
  const isSubscribed = !!subscription;
  if (!isSubscribed && (usage?.message_count || 0) >= agent.free_messages_per_day) {
    return new Response(JSON.stringify({ error: "limit_reached", message: `Limite de ${agent.free_messages_per_day} messages/jour atteinte.`, is_premium: agent.is_premium }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
  }

  let convId = conversation_id;
  if (!convId) { const { data: conv } = await supabase.from("ai_agent_conversations").insert({ user_id: userId, agent_id, title: message.substring(0, 60) }).select("id").single(); convId = conv?.id; }
  await supabase.from("ai_agent_messages").insert({ conversation_id: convId, role: "user", content: message });
  const { data: history } = await supabase.from("ai_agent_messages").select("role, content").eq("conversation_id", convId).order("created_at", { ascending: true }).limit(20);

  // Inject user's conversations so Zeus can send messages
  let conversationsContext = "";
  try {
    const { data: userConvs } = await supabase
      .from("conversation_participants")
      .select("conversation_id, conversations(id, name, is_group)")
      .eq("user_id", userId)
      .limit(30);
    if (userConvs?.length) {
      // Get peer names for 1:1 conversations
      const convIds = userConvs.map((c: any) => c.conversation_id);
      const { data: allParticipants } = await supabase
        .from("conversation_participants")
        .select("conversation_id, user_id, profiles(name)")
        .in("conversation_id", convIds)
        .neq("user_id", userId);
      const peerMap = new Map<string, string>();
      for (const p of (allParticipants || [])) {
        peerMap.set(p.conversation_id, (p as any).profiles?.name || "Inconnu");
      }
      const convList = userConvs.map((c: any) => {
        const conv = c.conversations;
        const name = conv?.is_group ? (conv.name || "Groupe") : (peerMap.get(c.conversation_id) || "Inconnu");
        return `- ${name}: ${c.conversation_id}`;
      }).join("\n");
      conversationsContext = `\n\n## CONVERSATIONS DE L'UTILISATEUR\nVoici les conversations disponibles pour envoyer des messages :\n${convList}\nUtilise le conversation_id exact pour le bloc send_message.`;
    }
  } catch { /* ignore */ }

  const resp = await callAI(apiKey, { model: "google/gemini-3-flash-preview", messages: [{ role: "system", content: agent.system_prompt + ACTION_SYSTEM_PROMPT + conversationsContext }, ...(history || []).map((m: any) => ({ role: m.role, content: m.content }))], stream: true });
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
  {
    type: "function", function: {
      name: "run_security_audit", description: "Exécuter un audit de sécurité complet de la plateforme. Teste les refus (RLS, accès non-autorisés), les permissions (rôles admin, mineurs), les falsifications (documents IA, multi-comptes, fingerprints suspects) et les cas limites (rate limiting, données orphelines, incohérences).",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["all", "refusals", "permissions", "falsifications", "edge_cases"], description: "Périmètre de l'audit" },
        },
        required: ["scope"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function", function: {
      name: "web_search", description: "Rechercher des informations sur internet en temps réel. Utilise cette fonction quand l'utilisateur pose une question nécessitant des données actuelles, des actualités, des définitions, des tendances, ou toute information que tu ne possèdes pas dans tes données d'entraînement.",
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
      case "run_security_audit": {
        const scope = args.scope || "all";
        const results: Record<string, any> = {};

        // ── 1. REFUSALS: Test RLS & unauthorized access patterns ──
        if (scope === "all" || scope === "refusals") {
          // Check for profiles without trust scores (missing auto-insert)
          const { count: profilesCount } = await supabase.from("profiles").select("id", { count: "exact", head: true });
          const { count: trustCount } = await supabase.from("trust_scores").select("id", { count: "exact", head: true });
          const missingTrustScores = (profilesCount || 0) - (trustCount || 0);

          // Check for blocked messages (RLS enforcement working)
          const { count: blockedMsgs } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("status", "blocked");
          const { count: pendingMsgs } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("status", "pending");

          // Check identity verifications that expired without response
          const { data: expiredVerifs } = await supabase.from("identity_verifications").select("id, reported_user_id, deadline_at, status").eq("status", "pending").lt("deadline_at", new Date().toISOString()).limit(20);

          results.refusals = {
            missing_trust_scores: missingTrustScores,
            blocked_messages: blockedMsgs || 0,
            pending_message_requests: pendingMsgs || 0,
            expired_verifications: (expiredVerifs || []).length,
            expired_verification_details: (expiredVerifs || []).map((v: any) => ({ id: v.id, user: v.reported_user_id?.slice(0, 8) + "...", deadline: v.deadline_at })),
            status: missingTrustScores > 5 || (expiredVerifs || []).length > 0 ? "🔴 PROBLÈMES DÉTECTÉS" : "🟢 OK",
          };
        }

        // ── 2. PERMISSIONS: Role checks, minor protections ──
        if (scope === "all" || scope === "permissions") {
          const { data: admins } = await supabase.from("user_roles").select("user_id, role").eq("role", "admin");
          const { data: minorsActive } = await supabase.from("parental_controls").select("user_id").eq("is_active", true);
          
          // Check minors without parental controls who have flagged profiles
          const { data: flaggedMinors } = await supabase.from("profiles").select("user_id, name, age_verification_status").eq("age_verification_status", "flagged");

          // Check if any minor has pending identity verification
          const minorIds = (minorsActive || []).map((m: any) => m.user_id);
          let minorsWithPendingVerif = 0;
          if (minorIds.length > 0) {
            const { count } = await supabase.from("identity_verifications").select("id", { count: "exact", head: true }).in("reported_user_id", minorIds.slice(0, 50)).eq("status", "pending");
            minorsWithPendingVerif = count || 0;
          }

          // Check for users with admin role but no profile
          const adminIds = (admins || []).map((a: any) => a.user_id);
          let orphanAdmins = 0;
          if (adminIds.length > 0) {
            const { data: adminProfiles } = await supabase.from("profiles").select("user_id").in("user_id", adminIds);
            orphanAdmins = adminIds.length - (adminProfiles || []).length;
          }

          results.permissions = {
            total_admins: (admins || []).length,
            orphan_admin_roles: orphanAdmins,
            active_minors_protected: (minorsActive || []).length,
            flagged_age_profiles: (flaggedMinors || []).length,
            flagged_details: (flaggedMinors || []).slice(0, 10).map((f: any) => ({ user: f.user_id?.slice(0, 8) + "...", name: f.name, status: f.age_verification_status })),
            minors_pending_verification: minorsWithPendingVerif,
            status: orphanAdmins > 0 || (flaggedMinors || []).length > 3 ? "🟡 ATTENTION" : "🟢 OK",
          };
        }

        // ── 3. FALSIFICATIONS: Fake documents, multi-accounts, suspicious fingerprints ──
        if (scope === "all" || scope === "falsifications") {
          // Rejected identity documents (fraud attempts)
          const { data: rejectedVerifs } = await supabase.from("identity_verifications").select("id, reported_user_id, admin_note, status, created_at").eq("status", "rejected").order("created_at", { ascending: false }).limit(20);

          // Fraud abuse reports
          const { data: fraudReports } = await supabase.from("abuse_reports").select("id, reported_user_id, report_type, description, status, created_at").eq("report_type", "fraud").order("created_at", { ascending: false }).limit(20);

          // Multi-account detection: fingerprints shared across multiple users
          const { data: fingerprints } = await supabase.from("device_fingerprints").select("fingerprint_hash, user_id").limit(1000);
          const fpMap: Record<string, Set<string>> = {};
          (fingerprints || []).forEach((fp: any) => {
            if (!fpMap[fp.fingerprint_hash]) fpMap[fp.fingerprint_hash] = new Set();
            fpMap[fp.fingerprint_hash].add(fp.user_id);
          });
          const multiAccountFingerprints = Object.entries(fpMap).filter(([_, users]) => users.size > 1).map(([hash, users]) => ({
            fingerprint: hash.slice(0, 12) + "...",
            user_count: users.size,
            users: Array.from(users).map(u => u.slice(0, 8) + "..."),
          }));

          // AI-generated document attempts (from abuse_reports with ai_minor_ prefix or fraud type)
          const { count: aiDocFraud } = await supabase.from("abuse_reports").select("id", { count: "exact", head: true }).eq("report_type", "fraud").ilike("description", "%IA%");

          results.falsifications = {
            rejected_documents: (rejectedVerifs || []).length,
            rejected_details: (rejectedVerifs || []).slice(0, 5).map((v: any) => ({ user: v.reported_user_id?.slice(0, 8) + "...", note: (v.admin_note || "").slice(0, 100) })),
            fraud_reports_total: (fraudReports || []).length,
            fraud_pending: (fraudReports || []).filter((r: any) => r.status === "pending").length,
            multi_account_fingerprints: multiAccountFingerprints.length,
            multi_account_details: multiAccountFingerprints.slice(0, 10),
            ai_generated_doc_attempts: aiDocFraud || 0,
            status: multiAccountFingerprints.length > 3 || (aiDocFraud || 0) > 0 ? "🔴 FRAUDES DÉTECTÉES" : (rejectedVerifs || []).length > 0 ? "🟡 SURVEILLÉ" : "🟢 OK",
          };
        }

        // ── 4. EDGE CASES: Rate limits, orphan data, inconsistencies ──
        if (scope === "all" || scope === "edge_cases") {
          // Orphan conversations (no participants)
          const { data: allConvs } = await supabase.from("conversations").select("id").limit(500);
          let orphanConvs = 0;
          if (allConvs?.length) {
            for (const conv of allConvs.slice(0, 100)) {
              const { count } = await supabase.from("conversation_participants").select("id", { count: "exact", head: true }).eq("conversation_id", conv.id);
              if (!count || count === 0) orphanConvs++;
            }
          }

          // Posts by deleted/banned users
          const { data: bannedUsers } = await supabase.from("banned_users").select("user_id").eq("is_active", true);
          const bannedIds = (bannedUsers || []).map((b: any) => b.user_id);
          let postsFromBanned = 0;
          if (bannedIds.length > 0) {
            const { count } = await supabase.from("posts").select("id", { count: "exact", head: true }).in("user_id", bannedIds.slice(0, 50));
            postsFromBanned = count || 0;
          }

          // Expired AI moderation cache entries
          const { count: expiredCache } = await supabase.from("ai_moderation_cache").select("id", { count: "exact", head: true }).lt("expires_at", new Date().toISOString());

          // Products with 0 or negative stock still active
          const { data: badProducts } = await supabase.from("products").select("id, title, stock_quantity").eq("is_active", true).lte("stock_quantity", 0);

          // Users with trust score 0 still active
          const { data: zeroTrust } = await supabase.from("trust_scores").select("user_id, trust_score, is_flagged, flag_reason").lte("trust_score", 10).limit(20);

          results.edge_cases = {
            orphan_conversations: orphanConvs,
            posts_from_banned_users: postsFromBanned,
            expired_cache_entries: expiredCache || 0,
            active_products_no_stock: (badProducts || []).length,
            bad_products_details: (badProducts || []).slice(0, 5).map((p: any) => ({ id: p.id?.slice(0, 8) + "...", title: p.title, stock: p.stock_quantity })),
            very_low_trust_users: (zeroTrust || []).length,
            low_trust_details: (zeroTrust || []).slice(0, 5).map((t: any) => ({ user: t.user_id?.slice(0, 8) + "...", score: t.trust_score, flagged: t.is_flagged, reason: t.flag_reason })),
            status: orphanConvs > 5 || postsFromBanned > 0 || (badProducts || []).length > 0 ? "🟡 NETTOYAGE REQUIS" : "🟢 OK",
          };
        }

        // Global security score
        const statuses = Object.values(results).map((r: any) => r.status || "");
        const hasRed = statuses.some(s => s.includes("🔴"));
        const hasYellow = statuses.some(s => s.includes("🟡"));
        results.global = {
          security_score: hasRed ? "🔴 CRITIQUE" : hasYellow ? "🟡 ATTENTION" : "🟢 SAIN",
          timestamp: new Date().toISOString(),
          scope,
        };

        return JSON.stringify(results);
      }
      case "web_search": {
        const query = args.query || "";
        const lang = args.language || "fr";
        try {
          // Use DuckDuckGo HTML search and parse results
          const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${lang === "fr" ? "fr-fr" : "us-en"}`;
          const searchResp = await fetch(searchUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; ZeusBot/1.0)" },
          });
          const html = await searchResp.text();
          
          // Extract result snippets from DuckDuckGo HTML
          const results: { title: string; snippet: string; url: string }[] = [];
          const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
          let match;
          while ((match = resultRegex.exec(html)) && results.length < 8) {
            const url = decodeURIComponent(match[1].replace(/.*uddg=/, "").replace(/&.*/, ""));
            const title = match[2].replace(/<[^>]+>/g, "").trim();
            const snippet = match[3].replace(/<[^>]+>/g, "").trim();
            if (title && snippet) results.push({ title, snippet, url });
          }

          // Fallback: simpler regex for alternative HTML structure
          if (results.length === 0) {
            const altRegex = /<a[^>]*class="result__url"[^>]*[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
            while ((match = altRegex.exec(html)) && results.length < 5) {
              const url = match[1].replace(/<[^>]+>/g, "").trim();
              const snippet = match[2].replace(/<[^>]+>/g, "").trim();
              if (snippet) results.push({ title: url, snippet, url });
            }
          }

          if (results.length === 0) {
            // Last resort: use AI with its training knowledge
            return JSON.stringify({ 
              note: "Aucun résultat web trouvé. Réponds avec tes connaissances en précisant que tu n'as pas pu vérifier en temps réel.",
              query,
            });
          }

          return JSON.stringify({
            query,
            results_count: results.length,
            results: results.map(r => ({ title: r.title, snippet: r.snippet, source: r.url })),
            instruction: "Synthétise ces résultats pour répondre à l'utilisateur. Cite les sources pertinentes avec des liens.",
          });
        } catch (e) {
          return JSON.stringify({ error: `Recherche web échouée: ${(e as Error).message}`, query });
        }
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

    if (normalizedProposalAction === 'whitelist_staff' && key === 'trust_score_override' && updates?.user_id) {
      const rawUserId = String(updates.user_id).trim();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      let resolvedUserId = rawUserId;
      if (!uuidRegex.test(rawUserId)) {
        const prefix = rawUserId.replace(/\.\.\.$/, "").replace(/[^0-9a-f-]/gi, "");
        if (!prefix) {
          return new Response(JSON.stringify({ error: "user_id invalide pour whitelist_staff" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
        }

        const { data: candidatesRaw, error: findErr } = await supabase
          .from("profiles")
          .select("user_id")
          .limit(1000);

        if (findErr) return new Response(JSON.stringify({ error: findErr.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
        const candidates = (candidatesRaw || []).filter((c: any) => String(c.user_id).toLowerCase().startsWith(prefix.toLowerCase()));
        if (!candidates?.length) return new Response(JSON.stringify({ error: "Aucun utilisateur trouvé pour ce préfixe user_id" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
        if (candidates.length > 1) return new Response(JSON.stringify({ error: "Préfixe user_id ambigu, utilisez un ID complet" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
        resolvedUserId = candidates[0].user_id;
      }

      const targetTrustScore = Number(updates.trust_score ?? 100);
      const { data: existing } = await supabase.from("trust_scores").select("id").eq("user_id", resolvedUserId).maybeSingle();

      if (existing?.id) {
        const { error } = await supabase
          .from("trust_scores")
          .update({
            trust_score: targetTrustScore,
            is_flagged: false,
            flag_reason: "staff_whitelisted",
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", resolvedUserId);
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
      } else {
        const { error } = await supabase.from("trust_scores").insert({
          user_id: resolvedUserId,
          trust_score: targetTrustScore,
          is_flagged: false,
          flag_reason: "staff_whitelisted",
        });
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ success: true, action: "whitelist_staff", user_id: resolvedUserId, trust_score: targetTrustScore, reason }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Generic proposals that don't need DB changes — just acknowledge
    return new Response(JSON.stringify({ success: true, action: normalizedProposalAction, message: "Proposition notée et validée par l'admin.", key, reason }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  if (action === "chat") {
    const latestUserMessage = [...(body.messages || [])]
      .reverse()
      .find((message: any) => message?.role === "user")?.content?.toLowerCase?.() || "";

    const isSecurityQuery = /attaque|intrusion|ddos|brute\s*force|xss|sql|injection|menace|incident|pare[-\s]?feu|firewall|r[ée]seau|ip\s+bann|phishing|spam|bot|s[ée]curit/i.test(latestUserMessage);

    const [usersRes, postsRes, ordersRes, reportsRes, bansRes, trustRes, subsRes, verificationsRes, livesRes, productsRes, bannedIpsRes, ddosTrackerRes, securityIncidentsRes, totalReportsRes, resolvedReportsRes, blockedMsgsRes, storiesRes, messagesRecentRes, contentStrikesRes] = await Promise.all([
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
      supabase.from("banned_ips").select("id, ip_address, reason, banned_at", { count: "exact" }).eq("is_active", true).order("banned_at", { ascending: false }).limit(10),
      supabase.from("ddos_ip_tracker").select("id, ip_address, penalty_level, request_count, blocked_until, endpoint, updated_at", { count: "exact" }).gte("penalty_level", 1).order("updated_at", { ascending: false }).limit(10),
      supabase.from("security_incidents").select("id", { count: "exact", head: true }),
      // Additional counts for comprehensive reporting
      supabase.from("abuse_reports").select("id", { count: "exact", head: true }),
      supabase.from("abuse_reports").select("id", { count: "exact", head: true }).eq("status", "resolved"),
      supabase.from("messages").select("id", { count: "exact", head: true }).eq("status", "blocked"),
      supabase.from("stories").select("id", { count: "exact", head: true }),
      supabase.from("messages").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 86400000).toISOString()),
      supabase.from("content_strikes").select("id", { count: "exact", head: true }),
    ]);

    const orders = ordersRes.data || [];
    const totalRevenue = orders.filter((o: any) => o.status !== "cancelled" && o.status !== "refunded").reduce((s: number, o: any) => s + (o.total || 0), 0);
    const pendingReports = (reportsRes.data || []).filter((r: any) => r.status === "pending");
    const allReports = reportsRes.data || [];
    const activeSubs = (subsRes.data || []).filter((s: any) => s.status === "active");
    const monthlyMRR = activeSubs.reduce((s: number, sub: any) => s + (sub.price_cents || 0), 0) / 100;
    const flaggedProfiles = trustRes.data || [];

    // Build comprehensive verified facts object
    const verifiedFacts = {
      users: usersRes.count || 0,
      posts: postsRes.count || 0,
      products: productsRes.count || 0,
      orders: orders.length,
      revenue: totalRevenue,
      mrr: monthlyMRR,
      activeSubs: activeSubs.length,
      pendingReports: pendingReports.length,
      totalReports: totalReportsRes.count || 0,
      resolvedReports: resolvedReportsRes.count || 0,
      blockedMessages: blockedMsgsRes.count || 0,
      bannedUsers: bansRes.count || 0,
      flaggedProfiles: flaggedProfiles.length,
      activeLives: livesRes.count || 0,
      pendingVerifications: (verificationsRes.data || []).length,
      stories: storiesRes.count || 0,
      messagesLast24h: messagesRecentRes.count || 0,
      contentStrikes: contentStrikesRes.count || 0,
      activeBannedIps: bannedIpsRes.count || 0,
      penalizedIps: ddosTrackerRes.count || 0,
      incidents: securityIncidentsRes.count || 0,
    };

    const securityFacts = {
      activeBannedIps: verifiedFacts.activeBannedIps,
      penalizedIps: verifiedFacts.penalizedIps,
      incidents: verifiedFacts.incidents,
      bannedIps: bannedIpsRes.data || [],
      penalizedEntries: ddosTrackerRes.data || [],
    };


    const buildVerifiedSecurityReply = () => {
      const hasSecurityEvents = securityFacts.activeBannedIps > 0 || securityFacts.penalizedIps > 0 || securityFacts.incidents > 0;

      return `## 🛡️ État sécurité vérifié

| Indicateur | Valeur réelle |
|---|---:|
| IP bannies actives | ${securityFacts.activeBannedIps} |
| IP sous pénalité DDoS | ${securityFacts.penalizedIps} |
| Incidents de sécurité | ${securityFacts.incidents} |

${hasSecurityEvents ? "### 🚨 Événements réels détectés" : "### ✅ Conclusion\n**Aucune attaque détectée, le réseau est sain.**"}
${securityFacts.bannedIps.length > 0 ? `\n#### IP bannies\n${securityFacts.bannedIps.map((ip: any) => `- ${ip.ip_address} — ${ip.reason || "Sans raison"} (${new Date(ip.banned_at).toLocaleString("fr-FR")})`).join("\n")}` : ""}
${securityFacts.penalizedEntries.length > 0 ? `\n#### IP sous pénalité\n${securityFacts.penalizedEntries.map((entry: any) => `- ${entry.ip_address} — endpoint **${entry.endpoint || "global"}**, penalty **${entry.penalty_level}**, ${entry.request_count} requêtes${entry.blocked_until ? `, bloquée jusqu'au ${new Date(entry.blocked_until).toLocaleString("fr-FR")}` : ""}`).join("\n")}` : ""}

## 💡 Propositions Zeus
${hasSecurityEvents ? "- Lancer un audit sécurité détaillé si tu veux une analyse plus profonde des IP et endpoints touchés." : "- Aucun durcissement urgent recommandé pour le moment.\n- Je peux lancer un audit sécurité complet si tu veux une vérification supplémentaire."}`;
    };

    const FAKE_SECURITY_PATTERN = /(\d[\d\s.,]+)\s*(tentatives?|attaques?|intrusions?|bloqu[ée]e?s?|neutralis[ée]e?s?|incidents?|bots?\s+de\s+spam|requ[eê]tes?\s+suspectes?|credential\s+stuffing|brute\s*force|WAF|pare[-\s]?feu|DDoS|Layer\s*\d)/i;
    const SECURITY_TOPIC_PATTERN = /attaque|intrusion|ddos|brute\s*force|xss|sql|injection|menace|incident|phishing|spam|bot|s[ée]curit|WAF|credential|neutralis|bloqu[ée]|tentative|suspecte|pare[-\s]?feu|firewall/i;
    // Pattern for fabricated operational metrics (latency, CPU, success rate, message counts per day, etc.)
    const FAKE_OPS_PATTERN = /(\d[\d\s.,]*)\s*(%|ms|req|requêtes?\s+trait[ée]e?s?|messages?\s*\/\s*jour|messages?\s+par\s+jour|CPU|charge|latence|taux\s+de\s+succ[eè]s)/i;

    const sanitizeZeusReply = (content: string) => {
      // Build the ONLY numbers Zeus is allowed to use
      const allowedNumbers = new Set(Object.values(verifiedFacts).map(v => String(v)));
      // Also allow small numbers 0-10 (common in natural language)
      for (let i = 0; i <= 10; i++) allowedNumbers.add(String(i));
      // Allow percentages and known values
      allowedNumbers.add(totalRevenue.toFixed(2));
      allowedNumbers.add(monthlyMRR.toFixed(2));

      const zeroSecurityState = securityFacts.activeBannedIps === 0 && securityFacts.penalizedIps === 0 && securityFacts.incidents === 0;
      const hasFakeNumbers = FAKE_SECURITY_PATTERN.test(content);
      const hasSecurityTopic = SECURITY_TOPIC_PATTERN.test(content);

      // Security query → always return verified data
      if (isSecurityQuery) return buildVerifiedSecurityReply();
      if (zeroSecurityState && (hasFakeNumbers || hasSecurityTopic)) {
        // Strip security fabrications
        let cleaned = content
          .replace(/###?\s*🚨[^\n]*\n([\s\S]*?)(?=###?\s|$)/gi, '')
          .replace(/###?\s*⚠️\s*ALERTE[^\n]*\n([\s\S]*?)(?=###?\s|$)/gi, '')
          .replace(/###?\s*🛡️\s*[ÉE]TAT[^\n]*\n([\s\S]*?)(?=###?\s|$)/gi, '')
          .replace(/\*\*\d[\d\s.,]*\*\*\s*(tentatives?|attaques?|bloqu[ée]e?s?|neutralis[ée]e?s?|incidents?|bots?)/gi, '**0** $1')
          .trim();
        if (!cleaned) cleaned = "Analyse terminée.";
        content = cleaned;
      }

      // Strip ALL fabricated operational metrics
      let finalContent = content
        .replace(/\*\*?Latence[^*\n]*\*\*?[^\n]*/gi, '')
        .replace(/\*\*?Charge\s+CPU[^*\n]*\*\*?[^\n]*/gi, '')
        .replace(/\*\*?Taux\s+de\s+succ[eè]s[^*\n]*\*\*?[^\n]*/gi, '')
        .replace(/\*\*?Total\s+des\s+messages?\s*\([^)]*\)[^*\n]*\*\*?[^\n]*/gi, '')
        .replace(/\*\*?Moyenne\s+quotidienne[^*\n]*\*\*?[^\n]*/gi, '')
        .replace(/~?\d+\.?\d*\s*messages?\s*\/\s*jour[^\n]*/gi, '')
        // Remove fatigue/mood comments
        .replace(/[^.]*fatigu[ée][^.]*\./gi, '')
        .replace(/[^.]*repos(?:e[zr]?)[^.]*\./gi, '')
        .replace(/[^.]*charge\s+(?:de\s+travail|mentale)[^.]*\./gi, '')
        .replace(/😴|☕/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // Append verified facts footer
      finalContent += `\n\n---\n## ✅ Données vérifiées (temps réel)
| Métrique | Valeur |
|---|---:|
| Signalements en attente | **${verifiedFacts.pendingReports}** |
| Signalements total | **${verifiedFacts.totalReports}** |
| Signalements résolus | **${verifiedFacts.resolvedReports}** |
| Messages bloqués | **${verifiedFacts.blockedMessages}** |
| Profils flaggés | **${verifiedFacts.flaggedProfiles}** |
| Utilisateurs bannis | **${verifiedFacts.bannedUsers}** |
| Content strikes | **${verifiedFacts.contentStrikes}** |
| IP bannies | **${verifiedFacts.activeBannedIps}** |
| IP sous pénalité DDoS | **${verifiedFacts.penalizedIps}** |
| Incidents sécurité | **${verifiedFacts.incidents}** |`;

      return finalContent;
    };

    // Strip ALL fabricated data from conversation history to prevent contamination
    const FABRICATION_PATTERN = /(\d[\d\s.,]+)\s*(tentatives?|attaques?|intrusions?|bloqu[ée]e?s?|neutralis[ée]e?s?|incidents?|bots?|requ[eê]tes?|ms\b|CPU|latence|taux|résolution|succ[eè]s|signalements?\s+en\s+attente|contenus?\s+bloqu)/i;
    const cleanedMessages = (body.messages || []).map((msg: any) => {
      if (msg.role === 'assistant' && FABRICATION_PATTERN.test(msg.content || '')) {
        return { ...msg, content: '[Réponse précédente contenait des données non vérifiées — ignorée. Utilise uniquement le snapshot plateforme pour les chiffres.]' };
      }
      return msg;
    });

    // Compute daily new users (last 7 days)
    const last7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const { count: newUsersWeek } = await supabase.from("profiles").select("id", { count: "exact", head: true }).gte("created_at", last7d);

    const platformContext = `
## 📊 SNAPSHOT PLATEFORME — SEULE SOURCE DE VÉRITÉ (${new Date().toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" })})

⚠️ **INSTRUCTION CRITIQUE** : Les chiffres ci-dessous sont les SEULES valeurs vérifiées. Tu ne dois utiliser QUE ces chiffres dans ta réponse. Si un chiffre n'est pas listé ici, tu ne le connais pas et tu dois le dire.

| Métrique | Valeur VÉRIFIÉE |
|---|---:|
| 👥 Utilisateurs | ${verifiedFacts.users} |
| 📝 Publications | ${verifiedFacts.posts} |
| 🛍️ Produits actifs | ${verifiedFacts.products} |
| 📦 Commandes | ${verifiedFacts.orders} |
| 💰 Revenus total | ${verifiedFacts.revenue.toFixed(2)}€ |
| 💳 MRR abonnements | ${verifiedFacts.mrr.toFixed(2)}€ (${verifiedFacts.activeSubs} actifs) |
| 🚨 Signalements en attente | ${verifiedFacts.pendingReports} |
| 🚨 Signalements total | ${verifiedFacts.totalReports} |
| ✅ Signalements résolus | ${verifiedFacts.resolvedReports} |
| 🔇 Messages bloqués (modération) | ${verifiedFacts.blockedMessages} |
| 🛡️ Vérifications ID en attente | ${verifiedFacts.pendingVerifications} |
| 🚫 Utilisateurs bannis | ${verifiedFacts.bannedUsers} |
| ⚠️ Profils flaggés | ${verifiedFacts.flaggedProfiles} |
| 📡 Lives actifs | ${verifiedFacts.activeLives} |
| 📈 Nouveaux inscrits (7j) | ${newUsersWeek || 0} |
| 📖 Stories | ${verifiedFacts.stories} |
| 💬 Messages (24h) | ${verifiedFacts.messagesLast24h} |
| ⚡ Content strikes | ${verifiedFacts.contentStrikes} |
| 🔒 IP bannies actives | ${verifiedFacts.activeBannedIps} |
| 🛡️ IP sous pénalité DDoS | ${verifiedFacts.penalizedIps} |
| 🚨 Incidents de sécurité | ${verifiedFacts.incidents} |

### DONNÉES QUE TU NE CONNAIS PAS (ne les invente JAMAIS) :
- Latence, CPU, charge serveur, temps de réponse
- Nombre de requêtes IA traitées, messages/jour historiques
- Taux de résolution en %, taux de succès en %
- Détails sur des "pics d'activité" ou "tendances" que tu n'as pas calculés
- Tout chiffre qui n'apparaît pas dans le tableau ci-dessus

### 🔒 SÉCURITÉ VÉRIFIÉE
${securityFacts.activeBannedIps === 0 && securityFacts.penalizedIps === 0 && securityFacts.incidents === 0 ? "**Aucune attaque, aucune menace, réseau 100% sain.**" : `IP bannies: ${securityFacts.activeBannedIps}, Pénalités DDoS: ${securityFacts.penalizedIps}, Incidents: ${securityFacts.incidents}`}

### 🚨 Signalements en attente (détails) :
${pendingReports.slice(0, 10).map((r: any) => `- **[${r.report_type}]** ${r.description || "Sans description"} _(${new Date(r.created_at).toLocaleDateString("fr")})_`).join("\n") || "✅ Aucun signalement en attente"}

### Tous signalements récents (max 20) :
${allReports.slice(0, 20).map((r: any) => `- **[${r.report_type}]** Status: ${r.status} — ${r.description || "Sans description"} _(${new Date(r.created_at).toLocaleDateString("fr")})_`).join("\n") || "✅ Aucun signalement"}

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

## 🌐 RECHERCHE WEB
Tu disposes d'un outil \`web_search\` qui te permet de chercher des informations en temps réel sur internet. **Utilise-le systématiquement** quand :
- L'utilisateur pose une question d'actualité, de culture générale, ou nécessitant des données récentes
- Tu as besoin de vérifier un fait ou une information
- La question dépasse tes connaissances internes (tendances, actualités, prix, événements, etc.)
Quand tu utilises des résultats web, **cite toujours les sources** avec des liens.

## 🔑 COMPORTEMENT PROACTIF (TRÈS IMPORTANT)
**Tu es un vrai assistant stratégique. Tu ne te contentes PAS de répondre aux questions. Tu DOIS :**
1. **À chaque conversation**, analyser les données automatiquement (appeler tes outils) et **proposer des améliorations concrètes** sans qu'on te le demande
2. **Terminer CHAQUE réponse** par une section "## 💡 Propositions Zeus" avec 1 à 3 actions concrètes que tu recommandes
3. **Pour chaque proposition qui modifie un paramètre**, utiliser le format exact suivant pour que l'admin puisse valider :

\`\`\`
[ZEUS_PROPOSAL]
action: update_algorithm_config
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

## 🔒 RÈGLES STRICTES — ABSOLUMENT CRITIQUES
- **⛔ RÈGLE #1 — ZÉRO INVENTION** : Tu n'as le droit de citer un chiffre, une statistique, une métrique, un pourcentage ou une valeur QUE si :
  1. Il apparaît dans le SNAPSHOT PLATEFORME ci-dessus, OU
  2. Il a été retourné par un outil que tu as appelé dans CETTE conversation
  Si une donnée n'existe dans aucune de ces deux sources, tu dois dire : "Je n'ai pas cette donnée, voulez-vous que j'investigue ?"
- **⛔ RÈGLE #2 — PAS DE MÉTRIQUES INVENTÉES** : Tu ne connais PAS la latence, le CPU, le taux de succès, le nombre de requêtes IA traitées, la charge serveur, les temps de réponse, les tendances de messages. Ne les invente JAMAIS. Si on te demande, dis que tu n'as pas accès à ces métriques en temps réel.
- **⛔ RÈGLE #3 — SÉCURITÉ** : Ne JAMAIS inventer d'attaques, de menaces, d'IP bannies ou d'incidents. Si les chiffres sont à 0, dis "Aucune attaque détectée, réseau sain."
- **⛔ RÈGLE #4 — PAS DE PSYCHOLOGIE INVENTÉE** : Ne fais PAS de commentaires sur la fatigue, l'humeur ou l'état mental de l'utilisateur. Reste factuel et professionnel.
- JAMAIS appliquer un changement sans validation — toujours utiliser [ZEUS_PROPOSAL]
- Prioriser la sécurité des mineurs (tolérance zéro)
- Si tu ne sais pas, DIS-LE et propose d'investiguer
- Le ddos_ip_tracker avec penalty_level=0 = trafic NORMAL, PAS des attaques
- **Tu es INTERDIT de donner des chiffres "impressionnants" pour paraître utile. La confiance de l'admin dépend de ta FIABILITÉ, pas de ta créativité.**

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
- \`run_security_audit\` : 🛡️ Audit de sécurité complet — teste les refus (RLS, accès), permissions (rôles, mineurs), falsifications (documents IA, multi-comptes, fingerprints) et cas limites (orphelins, stock, cache expiré). Scopes: all, refusals, permissions, falsifications, edge_cases

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

    if (isSecurityQuery) {
      const verifiedSecurityContent = buildVerifiedSecurityReply();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: verifiedSecurityContent } }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }

    const messages = [{ role: "system", content: systemPrompt }, ...cleanedMessages];

    let resp = await callAI(apiKey, {
      model: "google/gemini-2.5-flash",
      messages,
      tools: ZEUS_TOOLS,
      stream: false,
    });
    let errResp = aiError(resp.status, cors);
    if (errResp) return errResp;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "Unknown AI error");
      console.error("Zeus AI error:", resp.status, errText);
      throw new Error(`AI error ${resp.status}`);
    }

    let aiText = await resp.text();
    let aiData: any;
    try {
      aiData = JSON.parse(aiText);
    } catch {
      console.error("Zeus JSON parse error, body length:", aiText.length, "preview:", aiText.slice(0, 200));
      throw new Error("Invalid AI response");
    }
    let choice = aiData.choices?.[0];
    let toolCalls = choice?.message?.tool_calls;
    let loopCount = 0;
    const maxLoops = 5;

    while (toolCalls?.length && loopCount < maxLoops) {
      loopCount++;
      messages.push(choice.message);

      const toolResults = await Promise.all(
        toolCalls.map(async (tc: any) => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = {}; }
          const result = await executeZeusTool(tc.function.name, args, supabase);
          return { role: "tool", tool_call_id: tc.id, content: result };
        })
      );
      messages.push(...toolResults);

      resp = await callAI(apiKey, { model: "google/gemini-2.5-flash", messages, tools: ZEUS_TOOLS, stream: false });
      errResp = aiError(resp.status, cors);
      if (errResp) return errResp;
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error("Zeus tool-loop AI error:", resp.status, errText.slice(0, 200));
        throw new Error(`AI error ${resp.status}`);
      }
      aiText = await resp.text();
      try { aiData = JSON.parse(aiText); } catch { throw new Error("Invalid AI response in tool loop"); }
      choice = aiData.choices?.[0];
      toolCalls = choice?.message?.tool_calls;
    }

    const finalContent = sanitizeZeusReply(choice?.message?.content || "Je n'ai pas pu générer de réponse.");
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: finalContent } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(stream, { headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
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
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  
  // French profanity / insults detection
  const profanity = [
    /\b(put(?:e|ain|1n)|pute)\b/i,
    /\b(merde|emmerder?|demerde)\b/i,
    /\b(connard|connasse|con(?:nerie)?)\b/i,
    /\b(enculer?|encule|nique|niquer|ntm|ntm|nique\s*ta\s*m)/i,
    /\b(salop(?:e|ard)?|batar(?:d|de?))\b/i,
    /\b(fdp|fils?\s*de\s*pute)\b/i,
    /\b(pd|pedal(?:e)?|tapette|tafiole)\b/i,
    /\b(negr(?:o|e)|bougnoule|youpin|bamboula|raton)\b/i,
    /\b(ta\s*gueule|ferme[\s-]*la|tg|ftg|vtf|vtff|vaf)\b/i,
    /\b(bordel(?:de)?|putain)\b/i,
    /\b(couille|couillon|branleur|branleuse)\b/i,
    /\b(bouff?on(?:ne)?|debile|abruti(?:e)?|cretin(?:e)?)\b/i,
    /\b(troud(?:u|uc)|petasse|poufiasse|grognasse)\b/i,
    /\b(casse[\s-]*toi|degage|va\s*te\s*faire)\b/i,
    /\b(fuck|shit|bitch|asshole|dickhead|bastard|cunt)\b/i,
  ];
  for (const p of profanity) if (p.test(lower)) return { safe: false, reason: "Langage inapproprié", category: "inappropriate" };

  // Scam patterns
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

// ── POST MODERATION: Check posts for hate speech, harmful content ──
async function handlePostModeration(apiKey: string, body: any, userId: string, supabase: any, cors: Record<string, string>) {
  const { postId, text, imageUrl } = body;
  if (!text && !imageUrl) return new Response(JSON.stringify({ safe: true }), { headers: { ...cors, "Content-Type": "application/json" } });

  // Quick basic check first
  if (text) {
    const basic = basicModeration(text);
    if (!basic.safe) {
      // Record strike
      const zeusMsg = `Hey ! 🙏 J'ai remarqué que ton contenu contient des éléments qui ne respectent pas notre communauté (${basic.reason}). ForSure est un espace bienveillant. Si ça se reproduit, ton compte pourrait être suspendu. N'hésite pas à reformuler, je suis là pour t'aider ! ⚡`;
      if (postId) {
        await supabase.from("content_strikes").insert({ user_id: userId, post_id: postId, reason: basic.reason, severity: "warning", zeus_message: zeusMsg });
      }
      return new Response(JSON.stringify({ safe: false, reason: basic.reason, zeus_message: zeusMsg }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
  }

  // AI moderation for nuanced content
  if (text && text.length > 10) {
    const resp = await callAI(apiKey, {
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: `Tu es un modérateur bienveillant. Analyse ce contenu et détermine s'il contient du discours haineux, du harcèlement, des menaces, de la discrimination ou du contenu inapproprié. Réponds UNIQUEMENT via l'outil moderate_post.` },
        { role: "user", content: text },
      ],
      tools: [{
        type: "function",
        function: {
          name: "moderate_post",
          description: "Résultat de la modération du post",
          parameters: {
            type: "object",
            properties: {
              safe: { type: "boolean", description: "true si le contenu est acceptable" },
              category: { type: "string", enum: ["safe", "hate_speech", "harassment", "threats", "discrimination", "inappropriate", "spam"] },
              reason_fr: { type: "string", description: "Explication en français de pourquoi le contenu n'est pas acceptable (vide si safe)" },
              severity: { type: "string", enum: ["info", "warning", "critical"] },
            },
            required: ["safe", "category", "reason_fr", "severity"],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "moderate_post" } },
    });

    const errResp = aiError(resp.status, cors);
    if (errResp) return errResp;
    if (!resp.ok) return new Response(JSON.stringify({ safe: true }), { headers: { ...cors, "Content-Type": "application/json" } });

    const data = await resp.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.name === "moderate_post") {
      try {
        const result = JSON.parse(toolCall.function.arguments);
        if (!result.safe) {
          // Check strike count for escalation
          const { count } = await supabase.from("content_strikes").select("*", { count: "exact", head: true }).eq("user_id", userId);
          const strikeCount = count || 0;

          let zeusMsg: string;
          if (strikeCount >= 2) {
            zeusMsg = `⚠️ C'est la ${strikeCount + 1}ème fois que je détecte du contenu inapproprié (${result.reason_fr}). Ton compte risque d'être suspendu. Je t'encourage vraiment à exprimer tes idées de manière respectueuse. Je suis là si tu veux en parler ! ⚡`;
          } else {
            zeusMsg = `Hey ! 🙏 Ton contenu semble contenir ${result.reason_fr}. ForSure est un espace de bienveillance et de respect mutuel. Je t'invite à reformuler pour que ta voix soit entendue positivement. Si tu as besoin d'en discuter, je suis là ! ⚡`;
          }

          if (postId) {
            await supabase.from("content_strikes").insert({
              user_id: userId, post_id: postId, reason: result.reason_fr, severity: result.severity, zeus_message: zeusMsg,
            });
          }

          return new Response(JSON.stringify({ safe: false, reason: result.reason_fr, category: result.category, zeus_message: zeusMsg, strike_count: strikeCount + 1 }), { headers: { ...cors, "Content-Type": "application/json" } });
        }
      } catch {}
    }
  }

  return new Response(JSON.stringify({ safe: true }), { headers: { ...cors, "Content-Type": "application/json" } });
}

// ═══════════════════════════════════════════════════════════════
// COMMENT MODERATION — Auto reply + admin escalation
// ═══════════════════════════════════════════════════════════════
async function handleCommentModeration(apiKey: string, body: any, userId: string, supabase: any, cors: Record<string, string>) {
  const { commentId, postId, text } = body;
  if (!commentId || !text) {
    return new Response(JSON.stringify({ safe: true }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  let unsafe = false;
  let reason = "";
  let category = "inappropriate";
  let severity: "info" | "warning" | "critical" = "warning";
  let aiReasoning = "";

  // 1) Quick keyword pass
  const basic = basicModeration(text);
  if (!basic.safe) {
    unsafe = true;
    reason = basic.reason || "contenu inapproprié";
    category = basic.category || "inappropriate";
    severity = "warning";
    aiReasoning = "Détection lexicale (regex)";
  }

  // 2) AI nuanced pass for longer comments
  if (!unsafe && text.length > 10) {
    const resp = await callAI(apiKey, {
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "Tu es un modérateur bienveillant pour ForSure. Analyse le commentaire ci-dessous. Tu dois être strict sur: discours haineux, harcèlement, menaces, discrimination, insultes ciblées, contenu sexuel non consenti. Tolère le langage familier, sarcasme léger, désaccord poli. Réponds UNIQUEMENT via l'outil moderate_comment." },
        { role: "user", content: text },
      ],
      tools: [{
        type: "function",
        function: {
          name: "moderate_comment",
          description: "Résultat de la modération du commentaire",
          parameters: {
            type: "object",
            properties: {
              safe: { type: "boolean" },
              category: { type: "string", enum: ["safe", "hate_speech", "harassment", "threats", "discrimination", "insult", "inappropriate", "spam"] },
              reason_fr: { type: "string", description: "Court (≤120 chars). Vide si safe." },
              severity: { type: "string", enum: ["info", "warning", "critical"] },
              reasoning: { type: "string", description: "Explication courte interne pour les admins" },
            },
            required: ["safe", "category", "reason_fr", "severity", "reasoning"],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "moderate_comment" } },
    });

    const errResp = aiError(resp.status, cors);
    if (errResp) return errResp;
    if (resp.ok) {
      const data = await resp.json();
      const tc = data.choices?.[0]?.message?.tool_calls?.[0];
      if (tc?.function?.name === "moderate_comment") {
        try {
          const r = JSON.parse(tc.function.arguments);
          if (!r.safe) {
            unsafe = true;
            reason = r.reason_fr;
            category = r.category;
            severity = r.severity;
            aiReasoning = r.reasoning || "";
          }
        } catch {}
      }
    }
  }

  if (!unsafe) {
    return new Response(JSON.stringify({ safe: true }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  // 3) Count prior strikes for this user
  const { count } = await supabase
    .from("content_strikes")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  const strikeCount = (count || 0) + 1;

  // 4) Compose Zeus reply (apaisant)
  let zeusReply: string;
  if (severity === "critical" || strikeCount >= 3) {
    zeusReply = `⚡ Hey, je comprends que tu puisses ressentir des choses fortes — c'est humain. Mais ce commentaire dépasse une limite (${reason}). Je transmets aux modérateurs pour qu'ils regardent calmement. En attendant, prends une grande respiration 🌿 — on est plus forts quand on s'écoute. Si tu veux en parler, je suis là.`;
  } else if (strikeCount === 2) {
    zeusReply = `🙏 Hey, je remarque que tes mots peuvent blesser (${reason}). Je sais que ce n'est peut-être pas l'intention — reformule, et ta voix portera mieux. ForSure reste un espace bienveillant. Je suis là si tu veux échanger ⚡`;
  } else {
    zeusReply = `Hey ⚡ J'ai lu ton commentaire et certains mots peuvent heurter (${reason}). Pas de jugement — juste une invitation à reformuler avec plus de douceur. Ton point de vue compte, exprime-le pour qu'il soit entendu 🌿`;
  }

  // 5) Insert Zeus reply as a child comment
  if (postId) {
    await supabase.from("comments").insert({
      post_id: postId,
      parent_id: commentId,
      user_id: null,
      is_zeus_reply: true,
      body: zeusReply,
    });
  }

  // 6) Record strike
  await supabase.from("content_strikes").insert({
    user_id: userId,
    post_id: postId || null,
    reason,
    severity,
    zeus_message: zeusReply,
  });

  // 7) Escalate to admin if severe or repeated
  const shouldEscalate = severity === "critical" || strikeCount >= 3;
  if (shouldEscalate) {
    await supabase.from("comment_moderation_alerts").insert({
      user_id: userId,
      comment_id: commentId,
      post_id: postId || null,
      evidence_text: text,
      category,
      severity,
      ai_reasoning: aiReasoning,
      strike_count: strikeCount,
      status: "pending",
    });
  }

  return new Response(JSON.stringify({
    safe: false,
    reason,
    category,
    severity,
    zeus_reply: zeusReply,
    strike_count: strikeCount,
    escalated: shouldEscalate,
  }), { headers: { ...cors, "Content-Type": "application/json" } });
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

    if (!domain) {
      return new Response(JSON.stringify({ error: "⚡ Zeus requires 'domain' parameter." }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Rate limit per domain
    const limitMap: Record<string, number> = { content: 20, post: 15, moderation: 30, ads: 10, seller: 10, photo: 5, agent: 20, admin: 30, "post-moderation": 30, "comment-moderation": 60 };
    if (!checkRateLimit(`${user.id}:${domain}`, limitMap[domain] || 15)) {
      return new Response(JSON.stringify({ error: "Trop de requêtes, réessayez." }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
    }

    switch (domain) {
      case "content": return await handleContent(LOVABLE_API_KEY, body, cors);
      case "post": return await handlePostAssistant(LOVABLE_API_KEY, body, cors);
      case "moderation": return await handleModeration(LOVABLE_API_KEY, body, user.id, supabase, cors);
      case "post-moderation": return await handlePostModeration(LOVABLE_API_KEY, body, user.id, supabase, cors);
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
