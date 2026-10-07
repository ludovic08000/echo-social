import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.0";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit, getClientIP } from "../_shared/rate-limit.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Rate limit: 10 req/min per IP
  const ip = getClientIP(req);
  const rateLimited = await checkRateLimit(`feed-opt:${ip}`, 10, 60, corsHeaders);
  if (rateLimited) return rateLimited;

  // Admin only — exposes & mutates feed algorithm config.
  const { requireAdmin } = await import("../_shared/auth-guard.ts");
  const guard = await requireAdmin(req, corsHeaders);
  if (!("userId" in guard)) return guard.response;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { action, change_id } = await req.json();

    // ═════════════════════════════════════════════
    // LEVEL 1: OBSERVE — Gather & aggregate metrics
    // ═════════════════════════════════════════════
    if (action === "observe") {
      const since = new Date(Date.now() - 6 * 3600_000).toISOString();

      // Get recent metrics
      const { data: metrics, error: metricsError } = await supabase
        .from("feed_performance_metrics")
        .select("metric_type, value, session_id, metadata, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (metricsError) throw metricsError;

      if (!metrics || metrics.length === 0) {
        return new Response(
          JSON.stringify({ status: "no_data", message: "Pas assez de métriques pour analyser." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Aggregate
      const agg: Record<string, { values: number[]; count: number }> = {};
      for (const m of metrics) {
        if (!agg[m.metric_type]) agg[m.metric_type] = { values: [], count: 0 };
        agg[m.metric_type].values.push(Number(m.value));
        agg[m.metric_type].count++;
      }

      const summary: Record<string, any> = {};
      for (const [type, data] of Object.entries(agg)) {
        const sorted = data.values.sort((a, b) => a - b);
        summary[type] = {
          count: data.count,
          avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
          median: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          min: sorted[0],
          max: sorted[sorted.length - 1],
        };
      }

      // Get current config
      const { data: config, error: configError } = await supabase
        .from("ml_model_config")
        .select("key, value");
      if (configError) throw configError;

      const currentConfig: Record<string, any> = {};
      (config || []).forEach((c: any) => {
        currentConfig[c.key] = c.value;
      });

      return new Response(
        JSON.stringify({ status: "ok", summary, currentConfig, metricCount: metrics.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ═════════════════════════════════════════════════
    // LEVEL 2: RECOMMEND — Analyze & propose changes
    // ═════════════════════════════════════════════════
    if (action === "recommend") {
      const since = new Date(Date.now() - 6 * 3600_000).toISOString();

      const { data: metrics, error: metricsError } = await supabase
        .from("feed_performance_metrics")
        .select("metric_type, value, session_id, metadata, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (metricsError) throw metricsError;

      const { data: config, error: configError } = await supabase
        .from("ml_model_config")
        .select("key, value");
      if (configError) throw configError;

      const currentConfig: Record<string, any> = {};
      (config || []).forEach((c: any) => {
        currentConfig[c.key] = c.value;
      });

      const recommendations: any[] = [];

      // Aggregate metrics
      const byType: Record<string, number[]> = {};
      (metrics || []).forEach((m: any) => {
        if (!byType[m.metric_type]) byType[m.metric_type] = [];
        byType[m.metric_type].push(Number(m.value));
      });

      const avg = (arr: number[]) =>
        arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
      const p95 = (arr: number[]) => {
        if (!arr.length) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.95)];
      };

      // ── Rule 1: Load time too high ──
      const loadTimes = byType["load_time"] || [];
      if (loadTimes.length > 5) {
        const avgLoad = avg(loadTimes);
        const p95Load = p95(loadTimes);
        if (avgLoad > 2000) {
          recommendations.push({
            recommendation_type: "performance",
            severity: "critical",
            title: "⚠️ Temps de chargement élevé",
            description: `Le feed met en moyenne ${avgLoad}ms à charger (P95: ${p95Load}ms). Il faut réduire la pagination ou activer le préchargement.`,
            suggested_action: { action: "reduce_page_size", current: 20, suggested: 12 },
            auto_applicable: false,
          });
        } else if (avgLoad > 1200) {
          recommendations.push({
            recommendation_type: "performance",
            severity: "warning",
            title: "⏱ Chargement ralenti",
            description: `Le temps moyen de chargement a atteint ${avgLoad}ms. Surveillez cette tendance.`,
            suggested_action: null,
            auto_applicable: false,
          });
        }
      }

      // ── Rule 2: Too many posts rendered (memory pressure) ──
      const postsRendered = byType["posts_rendered"] || [];
      if (postsRendered.length > 3) {
        const maxRendered = Math.max(...postsRendered);
        if (maxRendered > 120) {
          recommendations.push({
            recommendation_type: "performance",
            severity: "critical",
            title: "🧠 Trop de posts en mémoire",
            description: `Le feed affiche jusqu'à ${maxRendered} posts. Il faut activer la virtualisation ou limiter le cache.`,
            suggested_action: { action: "enable_virtualization", current: false, suggested: true },
            auto_applicable: false,
          });
        } else if (maxRendered > 80) {
          recommendations.push({
            recommendation_type: "performance",
            severity: "warning",
            title: "📊 Posts en mémoire élevés",
            description: `${maxRendered} posts sont rendus en même temps. La purge des anciennes pages est recommandée.`,
            suggested_action: { action: "purge_old_pages" },
            auto_applicable: false,
          });
        }
      }

      // ── Rule 3: Low FPS (scroll jank) ──
      const fpsValues = byType["fps"] || [];
      if (fpsValues.length > 3) {
        const avgFps = avg(fpsValues);
        if (avgFps < 30) {
          recommendations.push({
            recommendation_type: "performance",
            severity: "critical",
            title: "🐌 Scroll saccadé détecté",
            description: `Le FPS moyen est de ${avgFps}. L'expérience utilisateur est dégradée. Réduisez les animations ou activez la virtualisation.`,
            suggested_action: { action: "reduce_animations" },
            auto_applicable: false,
          });
        }
      }

      // ── Rule 4: High abandonment rate ──
      // Rows are newest first. A resumed session can replace an earlier
      // abandonment=1 with 0; unfinished sessions are not the denominator.
      const sessionSummary = new Map<string, boolean>();
      for (const metric of metrics || []) {
        if (metric.metric_type === 'abandonment' && !sessionSummary.has(metric.session_id)) {
          sessionSummary.set(metric.session_id, Number(metric.value) > 0);
        }
      }
      const abandonedSessions = [...sessionSummary.values()].filter(Boolean).length;
      const abandonRate = Math.round(abandonedSessions / Math.max(1, sessionSummary.size) * 100);
      if (abandonRate > 30) {
        recommendations.push({
          recommendation_type: "content_insight",
          severity: "warning",
          title: "🚪 Taux d'abandon élevé",
          description: `${abandonRate}% des sessions quittent le feed avant 15% de scroll. Le contenu en tête du feed manque peut-être d'intérêt.`,
          suggested_action: { action: "review_ab_experiment", reason: "abandonment" },
          auto_applicable: false,
          safe_bounds: {},
        });
      }

      // ── Rule 5: Scroll depth analysis ──
      const scrollDepths = byType["scroll_depth"] || [];
      if (scrollDepths.length > 5) {
        const avgDepth = avg(scrollDepths);
        if (avgDepth < 20) {
          recommendations.push({
            recommendation_type: "content_insight",
            severity: "warning",
            title: "📉 Engagement de scroll faible",
            description: `Les utilisateurs ne scrollent qu'à ${avgDepth}% du feed en moyenne. Augmentez le diversity boost ou ajoutez du contenu varié.`,
            suggested_action: { action: "review_mmr_shadow", reason: "scroll_depth" },
            auto_applicable: false,
            safe_bounds: {},
          });
        } else if (avgDepth > 70) {
          recommendations.push({
            recommendation_type: "content_insight",
            severity: "info",
            title: "🔥 Excellent engagement",
            description: `La profondeur moyenne observée est ${avgDepth}%. À comparer à la satisfaction et aux retours négatifs ; le scroll seul ne valide pas le classement.`,
            suggested_action: null,
            auto_applicable: false,
          });
        }
      }

      // Save recommendations to DB
      if (recommendations.length > 0) {
        const stored = await supabase.from("feed_ai_recommendations").insert(
          recommendations.map((r) => ({
            ...r,
            status: "pending",
          }))
        );
        if (stored.error) throw stored.error;
      }

      return new Response(
        JSON.stringify({ status: "ok", recommendations, count: recommendations.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ═══════════════════════════════════════════════════════
    // Automatic mutation is disabled until a reviewed experiment is available.
    // ═══════════════════════════════════════════════════════
    if (action === "auto_apply") {
      return new Response(JSON.stringify({
        error: "EXPERIMENT_REQUIRED",
        message: "Modification automatique désactivée : valider une expérience avant de changer le classement.",
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══════════════════════════════════
    // ROLLBACK — Undo a config change
    // ═══════════════════════════════════
    if (action === "rollback") {
      if (typeof change_id !== "string" || !/^[0-9a-f-]{36}$/i.test(change_id)) {
        return new Response(JSON.stringify({ error: "change_id required" }), { status: 400, headers: corsHeaders });
      }
      const { data, error } = await supabase.rpc("rollback_feed_legacy_config", { p_change_id: change_id });
      if (error) return new Response(JSON.stringify({ error: "ROLLBACK_CONFLICT", message: "La configuration a changé ou ce retour arrière est indisponible." }), { status: 409, headers: corsHeaders });
      return new Response(JSON.stringify(data), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ══════════════════════════════════════
    // HISTORY — Get config change history
    // ══════════════════════════════════════
    if (action === "history") {
      const { data, error } = await supabase
        .from("feed_config_change_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;

      return new Response(
        JSON.stringify({ status: "ok", changes: data || [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown action. Use: observe, recommend, auto_apply, rollback, history" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
