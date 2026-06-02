import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit, getClientIP } from "../_shared/rate-limit.ts";

// ── Safe bounds for Level 3 (semi-autonomous) ──
const SAFE_BOUNDS: Record<string, { min: number; max: number }> = {
  discovery_boost: { min: 30, max: 70 },
  evening_boost: { min: 1.0, max: 1.8 },
  spam_penalty: { min: 0.3, max: 0.8 },
  diversity_penalty_base: { min: 5, max: 15 },
  marketplace_injection_interval: { min: 4, max: 10 },
  recency_tier_1h: { min: 35, max: 65 },
  engagement_cap: { min: 15, max: 40 },
};

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

    const { action } = await req.json();

    // ═════════════════════════════════════════════
    // LEVEL 1: OBSERVE — Gather & aggregate metrics
    // ═════════════════════════════════════════════
    if (action === "observe") {
      const since = new Date(Date.now() - 6 * 3600_000).toISOString();

      // Get recent metrics
      const { data: metrics } = await supabase
        .from("feed_performance_metrics")
        .select("metric_type, value, metadata, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000);

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
      const { data: config } = await supabase
        .from("feed_algorithm_config")
        .select("key, value");

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

      const { data: metrics } = await supabase
        .from("feed_performance_metrics")
        .select("metric_type, value, metadata, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000);

      const { data: config } = await supabase
        .from("feed_algorithm_config")
        .select("key, value");

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
      const abandonments = byType["abandonment"] || [];
      const totalSessions = new Set((metrics || []).map((m: any) => m.metadata?.session_id)).size || 1;
      const abandonRate = Math.round((abandonments.length / Math.max(1, totalSessions)) * 100);
      if (abandonRate > 30) {
        recommendations.push({
          recommendation_type: "content_insight",
          severity: "warning",
          title: "🚪 Taux d'abandon élevé",
          description: `${abandonRate}% des sessions quittent le feed avant 15% de scroll. Le contenu en tête du feed manque peut-être d'intérêt.`,
          suggested_action: { key: "discovery_boost", current: currentConfig.discovery_boost, suggested: Math.min(70, (Number(currentConfig.discovery_boost) || 50) + 10) },
          auto_applicable: true,
          safe_bounds: SAFE_BOUNDS.discovery_boost,
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
            suggested_action: { key: "diversity_penalty_base", current: currentConfig.diversity_penalty_base, suggested: 10 },
            auto_applicable: true,
            safe_bounds: SAFE_BOUNDS.diversity_penalty_base,
          });
        } else if (avgDepth > 70) {
          recommendations.push({
            recommendation_type: "content_insight",
            severity: "info",
            title: "🔥 Excellent engagement",
            description: `Les utilisateurs scrollent en moyenne à ${avgDepth}%. L'algorithme est bien calibré.`,
            suggested_action: null,
            auto_applicable: false,
          });
        }
      }

      // ── Rule 6: Time-based optimization ──
      const hour = new Date().getHours();
      if (hour >= 18 && hour <= 22) {
        const currentEvening = Number(currentConfig.evening_boost) || 1.3;
        if (currentEvening < 1.4) {
          recommendations.push({
            recommendation_type: "score_adjustment",
            severity: "info",
            title: "🌙 Boost soirée recommandé",
            description: `Il est ${hour}h, l'heure de pic d'activité. Le evening_boost actuel (${currentEvening}) pourrait être augmenté.`,
            suggested_action: { key: "evening_boost", current: currentEvening, suggested: 1.5 },
            auto_applicable: true,
            safe_bounds: SAFE_BOUNDS.evening_boost,
          });
        }
      }

      // Save recommendations to DB
      if (recommendations.length > 0) {
        await supabase.from("feed_ai_recommendations").insert(
          recommendations.map((r) => ({
            ...r,
            status: "pending",
          }))
        );
      }

      return new Response(
        JSON.stringify({ status: "ok", recommendations, count: recommendations.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ═══════════════════════════════════════════════════════
    // LEVEL 3: AUTO-APPLY — Apply safe adjustments in bounds
    // ═══════════════════════════════════════════════════════
    if (action === "auto_apply") {
      // Get pending auto-applicable recommendations
      const { data: recos } = await supabase
        .from("feed_ai_recommendations")
        .select("*")
        .eq("status", "pending")
        .eq("auto_applicable", true)
        .order("created_at", { ascending: false })
        .limit(10);

      if (!recos || recos.length === 0) {
        return new Response(
          JSON.stringify({ status: "ok", applied: 0, message: "Aucune recommandation auto-applicable." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let applied = 0;
      const appliedChanges: any[] = [];

      for (const reco of recos) {
        const action = reco.suggested_action as any;
        if (!action?.key || action.suggested === undefined) continue;

        const bounds = SAFE_BOUNDS[action.key];
        if (!bounds) continue;

        // Clamp to safe bounds
        const clampedValue = Math.max(bounds.min, Math.min(bounds.max, Number(action.suggested)));

        // Get current value
        const { data: current } = await supabase
          .from("feed_algorithm_config")
          .select("value")
          .eq("key", action.key)
          .maybeSingle();

        const oldValue = current?.value;

        // Apply change
        const { error } = await supabase
          .from("feed_algorithm_config")
          .upsert({
            key: action.key,
            value: clampedValue,
            description: `Auto-ajusté par IA: ${reco.title}`,
            updated_at: new Date().toISOString(),
          } as any, { onConflict: "key" });

        if (!error) {
          // Log the change
          await supabase.from("feed_config_change_log").insert({
            config_key: action.key,
            old_value: oldValue ?? null,
            new_value: clampedValue,
            change_source: "ai_auto",
            ai_level: "autonomous",
            reason: reco.title,
            applied_by: "system",
          } as any);

          // Mark recommendation as applied
          await supabase
            .from("feed_ai_recommendations")
            .update({ status: "applied", applied_at: new Date().toISOString() } as any)
            .eq("id", reco.id);

          applied++;
          appliedChanges.push({
            key: action.key,
            old: oldValue,
            new: clampedValue,
            reason: reco.title,
          });
        }
      }

      return new Response(
        JSON.stringify({ status: "ok", applied, changes: appliedChanges }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ═══════════════════════════════════
    // ROLLBACK — Undo a config change
    // ═══════════════════════════════════
    if (action === "rollback") {
      const { change_id } = await req.json().catch(() => ({}));
      if (!change_id) {
        return new Response(
          JSON.stringify({ error: "change_id required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: change } = await supabase
        .from("feed_config_change_log")
        .select("*")
        .eq("id", change_id)
        .single();

      if (!change || change.rolled_back) {
        return new Response(
          JSON.stringify({ error: "Change not found or already rolled back" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Restore old value
      if (change.old_value !== null) {
        await supabase
          .from("feed_algorithm_config")
          .update({ value: change.old_value, updated_at: new Date().toISOString() } as any)
          .eq("key", change.config_key);
      }

      // Mark as rolled back
      await supabase
        .from("feed_config_change_log")
        .update({ rolled_back: true, rolled_back_at: new Date().toISOString() } as any)
        .eq("id", change_id);

      return new Response(
        JSON.stringify({ status: "ok", rolled_back: change.config_key, restored_value: change.old_value }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ══════════════════════════════════════
    // HISTORY — Get config change history
    // ══════════════════════════════════════
    if (action === "history") {
      const { data } = await supabase
        .from("feed_config_change_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

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
