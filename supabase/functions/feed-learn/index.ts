import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Auth check — admin only
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user } } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Check admin role
    const { data: roleData } = await supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
    if (!roleData) {
      return new Response(JSON.stringify({ error: "Accès admin requis" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startTime = performance.now();

    // Create learning run record
    const { data: run } = await supabase.from("feed_learning_runs").insert({
      run_type: "full", status: "running",
    }).select("id").single();
    const runId = run?.id;

    // ── Step 1: Fetch recent posts (last 7 days, max 200) ──
    const { data: posts } = await supabase
      .from("posts")
      .select("id, user_id, body, image_url, likes_count, comments_count, created_at")
      .gt("created_at", new Date(Date.now() - 7 * 86400000).toISOString())
      .order("created_at", { ascending: false })
      .limit(200);

    if (!posts || posts.length === 0) {
      await supabase.from("feed_learning_runs").update({
        status: "completed", posts_analyzed: 0, completed_at: new Date().toISOString(),
        duration_ms: Math.round(performance.now() - startTime),
        summary: { message: "Aucun post récent à analyser" },
      }).eq("id", runId);
      return new Response(JSON.stringify({ success: true, message: "Aucun post à analyser" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Step 2: Trend & Moderation Analysis with Gemini ──
    const postsSummary = posts.map((p, i) => 
      `${i + 1}. [${p.likes_count}❤️ ${p.comments_count}💬] "${(p.body || "").substring(0, 200)}" (${p.image_url ? "avec média" : "texte seul"})`
    ).join("\n");

    const trendResponse = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Tu es un analyste IA pour un réseau social français. Analyse ces publications récentes et retourne tes résultats UNIQUEMENT via l'outil analyze_feed. Tu dois :
1. Détecter les tendances (sujets populaires, hashtags émergents)
2. Identifier les patterns de modération (types de contenus problématiques récurrents, nouvelles formes de spam/abus)
3. Évaluer le sentiment global de la communauté
4. Proposer des règles de modération améliorées basées sur les patterns observés
5. Détecter les sujets toxiques ou sensibles émergents`,
          },
          { role: "user", content: `Analyse ces ${posts.length} publications du feed :\n\n${postsSummary}` },
        ],
        tools: [{
          type: "function",
          function: {
            name: "analyze_feed",
            description: "Retourne l'analyse complète du feed",
            parameters: {
              type: "object",
              properties: {
                trends: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      topic: { type: "string" },
                      frequency: { type: "number", description: "Nombre de posts liés" },
                      sentiment: { type: "string", enum: ["positive", "neutral", "negative", "mixed"] },
                      engagement_level: { type: "string", enum: ["low", "medium", "high"] },
                    },
                    required: ["topic", "frequency", "sentiment", "engagement_level"],
                    additionalProperties: false,
                  },
                },
                moderation_patterns: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      pattern_type: { type: "string", enum: ["spam", "harassment", "hate_speech", "explicit", "scam", "manipulation", "none"] },
                      description: { type: "string" },
                      severity: { type: "string", enum: ["low", "medium", "high"] },
                      suggested_rule: { type: "string" },
                      confidence: { type: "number" },
                    },
                    required: ["pattern_type", "description", "severity", "confidence"],
                    additionalProperties: false,
                  },
                },
                community_sentiment: {
                  type: "object",
                  properties: {
                    overall: { type: "string", enum: ["very_positive", "positive", "neutral", "negative", "very_negative"] },
                    score: { type: "number", description: "-1 (très négatif) à 1 (très positif)" },
                    dominant_emotions: { type: "array", items: { type: "string" } },
                    concerns: { type: "array", items: { type: "string" } },
                  },
                  required: ["overall", "score", "dominant_emotions"],
                  additionalProperties: false,
                },
                feed_recommendations: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      action: { type: "string" },
                      reason: { type: "string" },
                      priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
                    },
                    required: ["action", "reason", "priority"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["trends", "moderation_patterns", "community_sentiment", "feed_recommendations"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "analyze_feed" } },
      }),
    });

    if (!trendResponse.ok) {
      const errStatus = trendResponse.status;
      await supabase.from("feed_learning_runs").update({
        status: "error", error_message: `AI error: ${errStatus}`,
        completed_at: new Date().toISOString(),
        duration_ms: Math.round(performance.now() - startTime),
      }).eq("id", runId);
      return new Response(JSON.stringify({ error: errStatus === 429 ? "Rate limited" : "AI error" }), {
        status: errStatus, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const trendData = await trendResponse.json();
    let analysis: any = {};
    try {
      const tc = trendData.choices?.[0]?.message?.tool_calls?.[0];
      if (tc?.function?.arguments) analysis = JSON.parse(tc.function.arguments);
    } catch {}

    // ── Step 3: Store insights ──
    const insightsToInsert: any[] = [];
    let trendsDetected = 0;
    let modRulesCreated = 0;

    // Trends
    if (analysis.trends) {
      for (const trend of analysis.trends) {
        insightsToInsert.push({
          insight_type: "trend",
          category: "engagement",
          title: trend.topic,
          description: `Sentiment: ${trend.sentiment}, Engagement: ${trend.engagement_level}`,
          data: trend,
          confidence: trend.frequency / posts.length,
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        });
        trendsDetected++;
      }
    }

    // Moderation patterns
    if (analysis.moderation_patterns) {
      for (const pattern of analysis.moderation_patterns) {
        if (pattern.pattern_type === "none") continue;
        insightsToInsert.push({
          insight_type: "moderation_pattern",
          category: "safety",
          title: `Pattern: ${pattern.pattern_type}`,
          description: pattern.description,
          data: pattern,
          confidence: pattern.confidence / 100,
        });
        // Auto-create learned rule if high confidence
        if (pattern.confidence >= 80 && pattern.suggested_rule) {
          await supabase.from("ai_learned_rules").insert({
            rule: pattern.suggested_rule,
            pattern: pattern.pattern_type,
          });
          modRulesCreated++;
        }
      }
    }

    // Community sentiment
    if (analysis.community_sentiment) {
      insightsToInsert.push({
        insight_type: "sentiment",
        category: "community",
        title: `Sentiment communautaire: ${analysis.community_sentiment.overall}`,
        description: `Score: ${analysis.community_sentiment.score}. Émotions: ${(analysis.community_sentiment.dominant_emotions || []).join(", ")}`,
        data: analysis.community_sentiment,
        confidence: 0.9,
        expires_at: new Date(Date.now() + 24 * 3600000).toISOString(),
      });
    }

    // Feed recommendations
    if (analysis.feed_recommendations) {
      for (const rec of analysis.feed_recommendations) {
        insightsToInsert.push({
          insight_type: "recommendation",
          category: "algorithm",
          title: rec.action,
          description: rec.reason,
          data: rec,
          confidence: rec.priority === "critical" ? 1 : rec.priority === "high" ? 0.8 : 0.5,
        });
      }
    }

    if (insightsToInsert.length > 0) {
      await supabase.from("feed_learning_insights").insert(insightsToInsert);
    }

    // ── Step 4: User profiling (top 20 most active users) ──
    const userPostMap: Record<string, typeof posts> = {};
    for (const p of posts) {
      if (!userPostMap[p.user_id]) userPostMap[p.user_id] = [];
      userPostMap[p.user_id].push(p);
    }

    const activeUsers = Object.entries(userPostMap)
      .sort(([, a], [, b]) => b.length - a.length)
      .slice(0, 20);

    let usersProfiled = 0;

    for (const [userId, userPosts] of activeUsers) {
      const userPostTexts = userPosts.map(p => p.body || "").filter(b => b.length > 5).slice(0, 10);
      if (userPostTexts.length < 2) continue;

      const profileResponse = await fetch(AI_GATEWAY, {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          messages: [
            { role: "system", content: "Analyse ces posts d'un utilisateur et retourne son profil via l'outil profile_user." },
            { role: "user", content: userPostTexts.join("\n---\n") },
          ],
          tools: [{
            type: "function",
            function: {
              name: "profile_user",
              description: "Profil utilisateur extrait des posts",
              parameters: {
                type: "object",
                properties: {
                  interests: { type: "array", items: { type: "string" }, description: "Centres d'intérêt détectés" },
                  sentiment_average: { type: "number", description: "-1 à 1" },
                  content_style: { type: "string", enum: ["casual", "formal", "creative", "informative", "emotional", "humorous"] },
                  top_topics: { type: "array", items: { type: "string" } },
                },
                required: ["interests", "sentiment_average", "content_style", "top_topics"],
                additionalProperties: false,
              },
            },
          }],
          tool_choice: { type: "function", function: { name: "profile_user" } },
        }),
      });

      if (!profileResponse.ok) continue;

      const profileData = await profileResponse.json();
      let profile: any = {};
      try {
        const tc = profileData.choices?.[0]?.message?.tool_calls?.[0];
        if (tc?.function?.arguments) profile = JSON.parse(tc.function.arguments);
      } catch { continue; }

      const totalEngagement = userPosts.reduce((s, p) => s + (p.likes_count || 0) + (p.comments_count || 0), 0);
      const engagementScore = totalEngagement / userPosts.length;

      await supabase.from("user_learned_profiles").upsert({
        user_id: userId,
        interests: profile.interests || [],
        sentiment_average: profile.sentiment_average || 0,
        content_style: profile.content_style || "casual",
        top_topics: profile.top_topics || [],
        engagement_score: engagementScore,
        posting_patterns: { posts_count: userPosts.length, avg_length: Math.round(userPostTexts.join("").length / userPostTexts.length) },
        last_analyzed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

      usersProfiled++;
    }

    // ── Step 5: Update run record ──
    const duration = Math.round(performance.now() - startTime);
    await supabase.from("feed_learning_runs").update({
      status: "completed",
      posts_analyzed: posts.length,
      users_profiled: usersProfiled,
      trends_detected: trendsDetected,
      moderation_rules_created: modRulesCreated,
      duration_ms: duration,
      completed_at: new Date().toISOString(),
      summary: {
        community_sentiment: analysis.community_sentiment?.overall || "unknown",
        top_trends: (analysis.trends || []).slice(0, 5).map((t: any) => t.topic),
        moderation_alerts: (analysis.moderation_patterns || []).filter((p: any) => p.severity === "high").length,
        recommendations_count: (analysis.feed_recommendations || []).length,
      },
    }).eq("id", runId);

    // Log to AI metrics
    await supabase.from("ai_metrics_log").insert({
      module_id: "feed-learning",
      metric_type: "learning_run",
      value: duration,
      metadata: { posts: posts.length, users: usersProfiled, trends: trendsDetected, rules: modRulesCreated },
    });

    return new Response(JSON.stringify({
      success: true,
      run_id: runId,
      posts_analyzed: posts.length,
      users_profiled: usersProfiled,
      trends_detected: trendsDetected,
      moderation_rules_created: modRulesCreated,
      duration_ms: duration,
      community_sentiment: analysis.community_sentiment,
      top_trends: (analysis.trends || []).slice(0, 5),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("feed-learn error:", e);
    return new Response(JSON.stringify({ error: "Erreur interne" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
