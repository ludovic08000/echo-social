import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Local detection engine (runs WITHOUT Gemini) ──────────────────────
interface DetectedIncident {
  incident_type: string;
  severity: string;
  source_ip: string | null;
  target_endpoint: string | null;
  attack_vector: string;
  success: boolean;
  vulnerability_found: string | null;
  raw_data: Record<string, unknown>;
  matched_pattern_id?: string;
}

/** Match incoming data against learned patterns — no AI needed */
function localPatternMatch(
  patterns: any[],
  ddosEvents: any[],
  fingerprints: any[],
  auditLogs: any[],
): DetectedIncident[] {
  const detected: DetectedIncident[] = [];

  for (const p of patterns) {
    const sig = p.pattern_signature || {};

    // IP-reputation pattern: check if a known-bad IP reappears
    if (sig.type === "ip_reputation" && sig.ip_addresses?.length) {
      const badIps = new Set(sig.ip_addresses as string[]);
      const matches = ddosEvents?.filter(e => badIps.has(e.ip_address)) || [];
      for (const m of matches) {
        detected.push({
          incident_type: "pattern_match_ip",
          severity: p.severity,
          source_ip: m.ip_address,
          target_endpoint: m.endpoint,
          attack_vector: `Matched learned pattern: ${p.pattern_name}`,
          success: false,
          vulnerability_found: null,
          raw_data: { pattern_id: p.id, pattern_name: p.pattern_name, confidence: p.confidence },
          matched_pattern_id: p.id,
        });
      }
    }

    // Fingerprint anomaly pattern
    if (sig.type === "fingerprint_anomaly" && sig.min_users) {
      const fpMap: Record<string, Set<string>> = {};
      fingerprints?.forEach(fp => {
        if (!fpMap[fp.fingerprint_hash]) fpMap[fp.fingerprint_hash] = new Set();
        fpMap[fp.fingerprint_hash].add(fp.user_id);
      });
      for (const [hash, users] of Object.entries(fpMap)) {
        if (users.size >= (sig.min_users as number)) {
          detected.push({
            incident_type: "pattern_match_fingerprint",
            severity: p.severity,
            source_ip: null,
            target_endpoint: null,
            attack_vector: `Matched learned pattern: ${p.pattern_name}`,
            success: true,
            vulnerability_found: `${users.size} accounts sharing fingerprint (threshold: ${sig.min_users})`,
            raw_data: { pattern_id: p.id, fingerprint: hash, user_count: users.size },
            matched_pattern_id: p.id,
          });
        }
      }
    }

    // Brute force pattern
    if (sig.type === "brute_force" && sig.min_attempts) {
      const loginFails = auditLogs?.filter(l => l.event_type === "login_failed") || [];
      const ipCounts: Record<string, number> = {};
      loginFails.forEach(l => {
        const ip = (l.metadata as any)?.ip || "unknown";
        ipCounts[ip] = (ipCounts[ip] || 0) + 1;
      });
      for (const [ip, count] of Object.entries(ipCounts)) {
        if (count >= (sig.min_attempts as number)) {
          detected.push({
            incident_type: "pattern_match_brute_force",
            severity: count >= 20 ? "critical" : p.severity,
            source_ip: ip,
            target_endpoint: null,
            attack_vector: `Matched learned pattern: ${p.pattern_name}`,
            success: false,
            vulnerability_found: null,
            raw_data: { pattern_id: p.id, attempts: count },
            matched_pattern_id: p.id,
          });
        }
      }
    }

    // Request spike pattern
    if (sig.type === "request_spike" && sig.min_requests) {
      const spikeIps = ddosEvents?.filter(e => e.request_count >= (sig.min_requests as number)) || [];
      for (const ev of spikeIps) {
        detected.push({
          incident_type: "pattern_match_spike",
          severity: p.severity,
          source_ip: ev.ip_address,
          target_endpoint: ev.endpoint,
          attack_vector: `Matched learned pattern: ${p.pattern_name}`,
          success: false,
          vulnerability_found: null,
          raw_data: { pattern_id: p.id, request_count: ev.request_count },
          matched_pattern_id: p.id,
        });
      }
    }
  }

  return detected;
}

// ── Heuristic scoring engine (runs WITHOUT Gemini) ──────────────────
function heuristicAnalysis(incidents: DetectedIncident[]): {
  platform_health: string;
  global_assessment: string;
} {
  let criticalCount = 0;
  let highCount = 0;
  let successCount = 0;

  for (const inc of incidents) {
    if (inc.severity === "critical") criticalCount++;
    if (inc.severity === "high") highCount++;
    if (inc.success) successCount++;
  }

  if (criticalCount >= 3 || (criticalCount >= 1 && successCount >= 2)) {
    return {
      platform_health: "under_attack",
      global_assessment: `${criticalCount} incidents critiques détectés dont ${successCount} attaques réussies. Intervention immédiate requise.`,
    };
  }
  if (criticalCount > 0 || highCount >= 3) {
    return {
      platform_health: "at_risk",
      global_assessment: `${criticalCount + highCount} incidents de haute sévérité. Surveillance renforcée active.`,
    };
  }
  if (incidents.length > 0) {
    return {
      platform_health: "at_risk",
      global_assessment: `${incidents.length} incident(s) détecté(s). Situation sous contrôle.`,
    };
  }
  return { platform_health: "safe", global_assessment: "Aucune menace détectée. Plateforme sécurisée." };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    // ── 1. Collect security data (last 10 min) ──
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const [
      { data: ddosEvents },
      { data: bannedIps },
      { data: abuseReports },
      { data: auditLogs },
      { data: fingerprints },
      { data: existingPatterns },
      { data: alertConfig },
      { data: recentIncidents },
    ] = await Promise.all([
      supabase.from("ddos_ip_tracker").select("*").gte("updated_at", since).order("updated_at", { ascending: false }).limit(50),
      supabase.from("banned_ips").select("*").eq("is_active", true).gte("banned_at", since),
      supabase.from("abuse_reports").select("*").gte("created_at", since),
      supabase.from("audit_logs").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(200),
      supabase.from("device_fingerprints").select("fingerprint_hash, ip_address, user_id, last_seen_at").gte("last_seen_at", since),
      supabase.from("security_ai_patterns").select("*").eq("is_active", true).order("confidence", { ascending: false }).limit(50),
      supabase.from("security_alert_config").select("*").eq("is_active", true).limit(1).maybeSingle(),
      // FIX: fetch recent incidents for dedup
      supabase.from("security_incidents").select("incident_type, source_ip, created_at").gte("created_at", since).limit(200),
    ]);

    // ── 2. Build dedup set from recent incidents ──
    const dedupSet = new Set<string>();
    recentIncidents?.forEach(ri => {
      dedupSet.add(`${ri.incident_type}::${ri.source_ip || "none"}`);
    });

    const isDuplicate = (type: string, ip: string | null) =>
      dedupSet.has(`${type}::${ip || "none"}`);

    // ── 3. Heuristic detection (no AI needed) ──
    const incidents: DetectedIncident[] = [];

    // DDoS detections
    const blockedIps = ddosEvents?.filter(e => e.blocked_until && new Date(e.blocked_until) > new Date()) || [];
    for (const ev of blockedIps) {
      if (isDuplicate("ddos_attempt", ev.ip_address)) continue;
      incidents.push({
        incident_type: "ddos_attempt",
        severity: ev.penalty_level >= 4 ? "critical" : ev.penalty_level >= 2 ? "high" : "medium",
        source_ip: ev.ip_address,
        target_endpoint: ev.endpoint,
        attack_vector: "HTTP flood",
        success: false,
        vulnerability_found: null,
        raw_data: { request_count: ev.request_count, penalty_level: ev.penalty_level, blocked_until: ev.blocked_until },
      });
    }

    // Multi-account detection
    const fpMap: Record<string, Set<string>> = {};
    fingerprints?.forEach(fp => {
      if (!fpMap[fp.fingerprint_hash]) fpMap[fp.fingerprint_hash] = new Set();
      fpMap[fp.fingerprint_hash].add(fp.user_id);
    });
    for (const [hash, users] of Object.entries(fpMap)) {
      if (users.size > 3 && !isDuplicate("multi_account", null)) {
        incidents.push({
          incident_type: "multi_account",
          severity: users.size > 10 ? "critical" : "high",
          source_ip: null,
          target_endpoint: null,
          attack_vector: "Device fingerprint sharing",
          success: true,
          vulnerability_found: `Same fingerprint used by ${users.size} accounts — insufficient device binding`,
          raw_data: { fingerprint: hash, user_count: users.size, user_ids: [...users].slice(0, 20) },
        });
      }
    }

    // Brute force detection
    const loginFailures = auditLogs?.filter(l => l.event_type === "login_failed") || [];
    const ipLoginAttempts: Record<string, number> = {};
    loginFailures.forEach(l => {
      const ip = (l.metadata as any)?.ip || "unknown";
      ipLoginAttempts[ip] = (ipLoginAttempts[ip] || 0) + 1;
    });
    for (const [ip, count] of Object.entries(ipLoginAttempts)) {
      if (count >= 5 && !isDuplicate("brute_force", ip)) {
        incidents.push({
          incident_type: "brute_force",
          severity: count >= 20 ? "critical" : "high",
          source_ip: ip,
          target_endpoint: null,
          attack_vector: "Credential stuffing / brute force",
          success: false,
          vulnerability_found: null,
          raw_data: { attempts: count, window: "10min" },
        });
      }
    }

    // Abuse surge
    if (abuseReports && abuseReports.length > 5 && !isDuplicate("abuse_surge", null)) {
      incidents.push({
        incident_type: "abuse_surge",
        severity: abuseReports.length > 20 ? "high" : "medium",
        source_ip: null,
        target_endpoint: null,
        attack_vector: "Social engineering / content abuse",
        success: true,
        vulnerability_found: "High volume of abuse reports suggests active harassment campaign",
        raw_data: { report_count: abuseReports.length },
      });
    }

    // ── 4. LOCAL PATTERN MATCHING (autonomous — no Gemini) ──
    const patternDetections = localPatternMatch(
      existingPatterns || [],
      ddosEvents || [],
      fingerprints || [],
      auditLogs || [],
    );

    // Add pattern detections (deduped)
    for (const pd of patternDetections) {
      const key = `${pd.incident_type}::${pd.source_ip || "none"}`;
      if (!dedupSet.has(key)) {
        incidents.push(pd);
        dedupSet.add(key);
      }
    }

    // Update matched pattern stats
    const matchedPatternIds = new Set(patternDetections.filter(d => d.matched_pattern_id).map(d => d.matched_pattern_id!));
    for (const pid of matchedPatternIds) {
      const pattern = existingPatterns?.find(p => p.id === pid);
      if (pattern) {
        await supabase.from("security_ai_patterns").update({
          times_matched: (pattern.times_matched || 0) + 1,
          confidence: Math.min(1, (pattern.confidence || 0.5) + 0.02),
          last_matched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", pid);
      }
    }

    // Decay confidence of patterns that haven't matched in 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const stalePatterns = existingPatterns?.filter(
      p => p.last_matched_at && p.last_matched_at < sevenDaysAgo && p.confidence > 0.1
    ) || [];
    for (const sp of stalePatterns) {
      await supabase.from("security_ai_patterns").update({
        confidence: Math.max(0.05, (sp.confidence || 0.5) - 0.03),
        updated_at: new Date().toISOString(),
      }).eq("id", sp.id);
    }

    // ── 5. Heuristic assessment (always available, no AI) ──
    const heuristic = heuristicAnalysis(incidents);
    let aiAnalysis: any = null;
    let usedAI = false;

    // ── 6. AI enrichment (only if incidents exist AND Gemini available) ──
    if (incidents.length > 0 && LOVABLE_API_KEY) {
      const patternsContext = existingPatterns?.map(
        p => `[${p.pattern_name}] conf:${p.confidence} matches:${p.times_matched} rule:"${p.detection_rule}" sig:${JSON.stringify(p.pattern_signature)}`
      ).join("\n") || "None";

      const prompt = `Tu es l'IA SOC de Forsure. Analyse ces incidents et AMÉLIORE les patterns de détection pour que le système local puisse détecter sans toi à l'avenir.

INCIDENTS (${incidents.length}):
${JSON.stringify(incidents.map((inc, i) => ({ index: i, ...inc })), null, 2)}

PATTERNS EXISTANTS:
${patternsContext}

STATS BRUTES (10 min):
- DDoS bloqués: ${blockedIps.length}
- Rapports abus: ${abuseReports?.length || 0}
- Logs audit: ${auditLogs?.length || 0}
- Auto-bans: ${bannedIps?.length || 0}
- Détections locales (sans toi): ${patternDetections.length}

IMPORTANT: Pour chaque new_pattern, la signature DOIT contenir un champ "type" parmi: "ip_reputation", "fingerprint_anomaly", "brute_force", "request_spike" pour que le moteur local puisse l'utiliser SANS AI. Inclus aussi les seuils numériques.

Réponds en JSON:
{
  "incidents_analysis": [{"index":N, "threat_level":"critical|high|medium|low", "attack_succeeded":bool, "vulnerability_description":str|null, "recommendation":str, "related_pattern":str|null}],
  "new_patterns": [{"pattern_name":str, "detection_rule":str, "severity":str, "confidence":float, "signature":{"type":"ip_reputation|fingerprint_anomaly|brute_force|request_spike", ...thresholds}}],
  "pattern_updates": [{"pattern_name":str, "new_confidence":float, "updated_signature":{...}}],
  "global_threat_assessment": str,
  "platform_health": "safe|at_risk|under_attack",
  "self_improvement_notes": str,
  "autonomy_score": float (0-1, how well the local engine would handle these incidents without AI)
}`;

      try {
        const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: "Tu es une IA SOC experte. Ta mission principale est de FORMER le moteur de détection local pour qu'il devienne autonome. Chaque pattern que tu crées doit avoir une signature technique exploitable sans IA. Réponds en JSON valide uniquement." },
              { role: "user", content: prompt },
            ],
          }),
        });

        if (aiResp.ok) {
          const aiData = await aiResp.json();
          const content = aiData.choices?.[0]?.message?.content || "";
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              aiAnalysis = JSON.parse(jsonMatch[0]);
              usedAI = true;
            } catch {
              console.warn("AI response JSON parse failed, using heuristics only");
            }
          }
        } else {
          console.warn(`AI gateway returned ${aiResp.status}, using heuristics only`);
        }
      } catch (e) {
        console.error("AI analysis error, falling back to heuristics:", e);
      }
    }

    // ── 7. Store incidents (with correct index mapping) ──
    const storedIncidents: string[] = [];
    for (let i = 0; i < incidents.length; i++) {
      const inc = incidents[i];
      const analysis = aiAnalysis?.incidents_analysis?.find((a: any) => a.index === i);

      const { data: inserted } = await supabase.from("security_incidents").insert({
        incident_type: inc.incident_type,
        severity: analysis?.threat_level || inc.severity,
        status: "detected",
        source_ip: inc.source_ip || null,
        target_endpoint: inc.target_endpoint || null,
        attack_vector: inc.attack_vector,
        success: analysis?.attack_succeeded ?? inc.success,
        vulnerability_found: analysis?.vulnerability_description || inc.vulnerability_found,
        ai_analysis: analysis ? JSON.stringify(analysis) : (inc.matched_pattern_id ? JSON.stringify({ local_pattern: true, pattern_id: inc.matched_pattern_id }) : null),
        ai_recommendation: analysis?.recommendation || (inc.matched_pattern_id ? "Détecté par pattern local appris" : null),
        raw_data: inc.raw_data,
      }).select("id").single();

      if (inserted) storedIncidents.push(inserted.id);
    }

    // ── 8. Learn new patterns from AI ──
    let patternsLearned = 0;
    if (aiAnalysis?.new_patterns?.length > 0) {
      for (const pattern of aiAnalysis.new_patterns) {
        if (!pattern.pattern_name || !pattern.detection_rule) continue;

        const { data: existing } = await supabase
          .from("security_ai_patterns")
          .select("id, times_matched, confidence")
          .eq("pattern_name", pattern.pattern_name)
          .maybeSingle();

        if (existing) {
          await supabase.from("security_ai_patterns").update({
            times_matched: existing.times_matched + 1,
            confidence: Math.min(1, existing.confidence + 0.05),
            pattern_signature: pattern.signature || {},
            detection_rule: pattern.detection_rule,
            last_matched_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", existing.id);
        } else {
          await supabase.from("security_ai_patterns").insert({
            pattern_name: pattern.pattern_name,
            pattern_signature: pattern.signature || {},
            detection_rule: pattern.detection_rule,
            severity: pattern.severity || "medium",
            confidence: pattern.confidence || 0.5,
            source: "ai_learned",
          });
          patternsLearned++;
        }
      }
    }

    // Update existing patterns with AI feedback
    if (aiAnalysis?.pattern_updates?.length > 0) {
      for (const update of aiAnalysis.pattern_updates) {
        if (!update.pattern_name) continue;
        const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (update.new_confidence != null) updateData.confidence = Math.min(1, Math.max(0.05, update.new_confidence));
        if (update.updated_signature) updateData.pattern_signature = update.updated_signature;

        await supabase.from("security_ai_patterns")
          .update(updateData)
          .eq("pattern_name", update.pattern_name);
      }
    }

    // ── 9. Email alert (FIX: correct index mapping) ──
    const finalHealth = aiAnalysis?.platform_health || heuristic.platform_health;
    const finalAssessment = aiAnalysis?.global_threat_assessment || heuristic.global_assessment;

    // Build array with original indices preserved
    const criticalWithIndex = incidents
      .map((inc, originalIdx) => ({ inc, originalIdx }))
      .filter(({ inc, originalIdx }) => {
        const analysis = aiAnalysis?.incidents_analysis?.find((a: any) => a.index === originalIdx);
        const sev = analysis?.threat_level || inc.severity;
        return sev === "critical" || sev === "high";
      });

    if (criticalWithIndex.length > 0 && alertConfig?.alert_email) {
      const emailBody = `🚨 ALERTE SÉCURITÉ FORSURE

${finalHealth === "under_attack" ? "⚠️ PLATEFORME SOUS ATTAQUE" : "⚡ Incidents de sécurité détectés"}

📊 Résumé: ${finalAssessment}

🤖 Mode: ${usedAI ? "IA + Heuristiques" : "Heuristiques locales uniquement"}
📈 Détections locales: ${patternDetections.length}/${incidents.length} (${incidents.length > 0 ? Math.round(patternDetections.length / incidents.length * 100) : 0}% autonomie)

📋 Détails (${criticalWithIndex.length} critiques/hauts):
${criticalWithIndex.map(({ inc, originalIdx }) => {
  const analysis = aiAnalysis?.incidents_analysis?.find((a: any) => a.index === originalIdx);
  const succeeded = analysis?.attack_succeeded ?? inc.success;
  return `
━━━━━━━━━━━━━━━━━━━━━
🔴 ${inc.incident_type.toUpperCase()}
   Sévérité: ${analysis?.threat_level || inc.severity}
   IP: ${inc.source_ip || "N/A"}
   Vecteur: ${inc.attack_vector}
   Résultat: ${succeeded ? "⚠️ ATTAQUE RÉUSSIE" : "✅ BLOQUÉE"}${succeeded ? `\n   🔓 FAILLE: ${analysis?.vulnerability_description || inc.vulnerability_found || "Analyse en cours"}` : ""}
   💡 Action: ${analysis?.recommendation || "Vérifier les logs"}`;
}).join("\n")}

🧠 Auto-apprentissage: ${aiAnalysis?.self_improvement_notes || "Patterns mis à jour via heuristiques"}
${aiAnalysis?.autonomy_score != null ? `🎯 Score autonomie: ${Math.round(aiAnalysis.autonomy_score * 100)}%` : ""}
🕐 ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}

— Forsure Security AI`;

      try {
        await supabase.rpc("enqueue_email", {
          queue_name: "transactional_emails",
          payload: {
            to: alertConfig.alert_email,
            subject: `🚨 Sécurité Forsure — ${criticalWithIndex.length} incident(s) ${finalHealth === "under_attack" ? "SOUS ATTAQUE" : "détecté(s)"}`,
            html: `<pre style="font-family:'Courier New',monospace;white-space:pre-wrap;max-width:640px;margin:0 auto;padding:24px;background:#0a0a0a;color:#e0e0e0;border-radius:12px;line-height:1.6;">${emailBody.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
            purpose: "transactional",
          },
        });

        if (storedIncidents.length > 0) {
          await supabase.from("security_incidents").update({ alert_sent: true }).in("id", storedIncidents);
        }
      } catch (emailErr) {
        console.error("Email alert error:", emailErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      incidents_detected: incidents.length,
      incidents_stored: storedIncidents.length,
      local_detections: patternDetections.length,
      ai_used: usedAI,
      patterns_learned: patternsLearned,
      patterns_total: (existingPatterns?.length || 0) + patternsLearned,
      platform_health: finalHealth,
      alert_sent: criticalWithIndex.length > 0 && !!alertConfig?.alert_email,
      global_assessment: finalAssessment,
      autonomy_score: usedAI ? (aiAnalysis?.autonomy_score || null) : (patternDetections.length > 0 ? 1.0 : null),
      self_improvement: aiAnalysis?.self_improvement_notes || null,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Security monitor error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
