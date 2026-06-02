import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── ÉTAPE 2 : Scoring de confiance local structuré ──────────────────
interface ConfidenceFactors {
  ip_reputation: number;       // 0-1 (known bad IP = 1)
  frequency: number;           // 0-1 (high frequency = 1)
  fingerprint_anomaly: number; // 0-1
  pattern_match: number;       // 0-1 (already seen = 1)
  proximity_to_past: number;   // 0-1 (similar to past incident)
  behavior_anomaly: number;    // 0-1
  reputation_score: number;    // 0-1 (trust score inverse)
}

function computeConfidenceScore(factors: ConfidenceFactors): number {
  const weights = {
    ip_reputation: 0.20,
    frequency: 0.15,
    fingerprint_anomaly: 0.15,
    pattern_match: 0.25,
    proximity_to_past: 0.10,
    behavior_anomaly: 0.10,
    reputation_score: 0.05,
  };
  let score = 0;
  for (const [k, w] of Object.entries(weights)) {
    score += (factors[k as keyof ConfidenceFactors] || 0) * w;
  }
  return Math.min(1, Math.max(0, score));
}

// ── ÉTAPE 3 : Autonomie progressive ──────────────────────────────────
// Level 1: local engine only (fast, no API cost)
// Level 2: local + Gemini validation on ambiguous cases (confidence 0.3-0.7)
// Level 3: auto-block on confirmed patterns (confidence > 0.85, matched >= 3)
function determineAutonomyLevel(
  confidenceScore: number,
  patternConfirmedCount: number,
  patternConfidence: number,
): { level: number; needsAI: boolean; action: string } {
  // Level 3: auto-block — pattern confirmed multiple times, very high confidence
  if (patternConfidence >= 0.85 && patternConfirmedCount >= 3 && confidenceScore >= 0.75) {
    return { level: 3, needsAI: false, action: "auto_block" };
  }
  // Level 1: local-only — clear threat or clearly safe
  if (confidenceScore >= 0.7 || confidenceScore <= 0.2) {
    return { level: 1, needsAI: false, action: confidenceScore >= 0.7 ? "flag" : "allow" };
  }
  // Level 2: ambiguous — ask Gemini
  return { level: 2, needsAI: true, action: "pending_ai" };
}

// ── Structured incident with confidence ──────────────────────────────
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
  confidence_score: number;
  confidence_factors: ConfidenceFactors;
  autonomy_level: number;
  detection_source: "heuristic" | "pattern" | "ai" | "auto_block";
}

// ── Local pattern matching with confidence scoring ───────────────────
function localPatternMatch(
  patterns: any[],
  ddosEvents: any[],
  fingerprints: any[],
  auditLogs: any[],
  knownBadIps: Set<string>,
  pastIncidentTypes: Map<string, number>,
): DetectedIncident[] {
  const detected: DetectedIncident[] = [];

  for (const p of patterns) {
    const sig = p.pattern_signature || {};
    const patternConf = p.confidence || 0.5;
    const confirmedCount = p.confirmed_count || 0;

    if (sig.type === "ip_reputation" && sig.ip_addresses?.length) {
      const badIps = new Set(sig.ip_addresses as string[]);
      const matches = ddosEvents?.filter(e => badIps.has(e.ip_address)) || [];
      for (const m of matches) {
        const factors: ConfidenceFactors = {
          ip_reputation: 1.0,
          frequency: Math.min(1, (m.request_count || 0) / 500),
          fingerprint_anomaly: 0,
          pattern_match: patternConf,
          proximity_to_past: pastIncidentTypes.has("pattern_match_ip") ? 0.8 : 0,
          behavior_anomaly: m.penalty_level >= 3 ? 0.9 : 0.3,
          reputation_score: knownBadIps.has(m.ip_address) ? 1.0 : 0.2,
        };
        const confScore = computeConfidenceScore(factors);
        const auto = determineAutonomyLevel(confScore, confirmedCount, patternConf);
        detected.push({
          incident_type: "pattern_match_ip",
          severity: auto.level === 3 ? "critical" : p.severity,
          source_ip: m.ip_address,
          target_endpoint: m.endpoint,
          attack_vector: `Pattern: ${p.pattern_name}`,
          success: false,
          vulnerability_found: null,
          raw_data: { pattern_id: p.id, pattern_name: p.pattern_name, confidence: patternConf },
          matched_pattern_id: p.id,
          confidence_score: confScore,
          confidence_factors: factors,
          autonomy_level: auto.level,
          detection_source: auto.level === 3 ? "auto_block" : "pattern",
        });
      }
    }

    if (sig.type === "fingerprint_anomaly" && sig.min_users) {
      const fpMap: Record<string, Set<string>> = {};
      fingerprints?.forEach(fp => {
        if (!fpMap[fp.fingerprint_hash]) fpMap[fp.fingerprint_hash] = new Set();
        fpMap[fp.fingerprint_hash].add(fp.user_id);
      });
      for (const [hash, users] of Object.entries(fpMap)) {
        if (users.size >= (sig.min_users as number)) {
          const factors: ConfidenceFactors = {
            ip_reputation: 0.2,
            frequency: Math.min(1, users.size / 10),
            fingerprint_anomaly: 1.0,
            pattern_match: patternConf,
            proximity_to_past: pastIncidentTypes.has("pattern_match_fingerprint") ? 0.7 : 0,
            behavior_anomaly: 0.8,
            reputation_score: 0.5,
          };
          const confScore = computeConfidenceScore(factors);
          const auto = determineAutonomyLevel(confScore, confirmedCount, patternConf);
          detected.push({
            incident_type: "pattern_match_fingerprint",
            severity: auto.level === 3 ? "critical" : p.severity,
            source_ip: null,
            target_endpoint: null,
            attack_vector: `Pattern: ${p.pattern_name}`,
            success: true,
            vulnerability_found: `${users.size} accounts sharing fingerprint`,
            raw_data: { pattern_id: p.id, fingerprint: hash, user_count: users.size },
            matched_pattern_id: p.id,
            confidence_score: confScore,
            confidence_factors: factors,
            autonomy_level: auto.level,
            detection_source: auto.level === 3 ? "auto_block" : "pattern",
          });
        }
      }
    }

    if (sig.type === "brute_force" && sig.min_attempts) {
      const loginFails = auditLogs?.filter(l => l.event_type === "login_failed") || [];
      const ipCounts: Record<string, number> = {};
      loginFails.forEach(l => {
        const ip = (l.metadata as any)?.ip || "unknown";
        ipCounts[ip] = (ipCounts[ip] || 0) + 1;
      });
      for (const [ip, count] of Object.entries(ipCounts)) {
        if (count >= (sig.min_attempts as number)) {
          const factors: ConfidenceFactors = {
            ip_reputation: knownBadIps.has(ip) ? 1.0 : 0.4,
            frequency: Math.min(1, count / 20),
            fingerprint_anomaly: 0,
            pattern_match: patternConf,
            proximity_to_past: pastIncidentTypes.has("brute_force") ? 0.9 : 0,
            behavior_anomaly: count >= 20 ? 1.0 : 0.5,
            reputation_score: 0.6,
          };
          const confScore = computeConfidenceScore(factors);
          const auto = determineAutonomyLevel(confScore, confirmedCount, patternConf);
          detected.push({
            incident_type: "pattern_match_brute_force",
            severity: count >= 20 ? "critical" : p.severity,
            source_ip: ip,
            target_endpoint: null,
            attack_vector: `Pattern: ${p.pattern_name}`,
            success: false,
            vulnerability_found: null,
            raw_data: { pattern_id: p.id, attempts: count },
            matched_pattern_id: p.id,
            confidence_score: confScore,
            confidence_factors: factors,
            autonomy_level: auto.level,
            detection_source: auto.level === 3 ? "auto_block" : "pattern",
          });
        }
      }
    }

    if (sig.type === "request_spike" && sig.min_requests) {
      const spikeIps = ddosEvents?.filter(e => e.request_count >= (sig.min_requests as number)) || [];
      for (const ev of spikeIps) {
        const factors: ConfidenceFactors = {
          ip_reputation: knownBadIps.has(ev.ip_address) ? 1.0 : 0.3,
          frequency: Math.min(1, ev.request_count / 1000),
          fingerprint_anomaly: 0,
          pattern_match: patternConf,
          proximity_to_past: pastIncidentTypes.has("pattern_match_spike") ? 0.7 : 0,
          behavior_anomaly: ev.request_count >= 500 ? 0.9 : 0.4,
          reputation_score: 0.4,
        };
        const confScore = computeConfidenceScore(factors);
        const auto = determineAutonomyLevel(confScore, confirmedCount, patternConf);
        detected.push({
          incident_type: "pattern_match_spike",
          severity: auto.level === 3 ? "critical" : p.severity,
          source_ip: ev.ip_address,
          target_endpoint: ev.endpoint,
          attack_vector: `Pattern: ${p.pattern_name}`,
          success: false,
          vulnerability_found: null,
          raw_data: { pattern_id: p.id, request_count: ev.request_count },
          matched_pattern_id: p.id,
          confidence_score: confScore,
          confidence_factors: factors,
          autonomy_level: auto.level,
          detection_source: auto.level === 3 ? "auto_block" : "pattern",
        });
      }
    }
  }

  return detected;
}

// ── Heuristic scoring ────────────────────────────────────────────────
function heuristicAnalysis(incidents: DetectedIncident[]): {
  platform_health: string;
  global_assessment: string;
} {
  let criticalCount = 0, highCount = 0, successCount = 0;
  for (const inc of incidents) {
    if (inc.severity === "critical") criticalCount++;
    if (inc.severity === "high") highCount++;
    if (inc.success) successCount++;
  }
  if (criticalCount >= 3 || (criticalCount >= 1 && successCount >= 2)) {
    return { platform_health: "under_attack", global_assessment: `${criticalCount} incidents critiques dont ${successCount} attaques réussies. Intervention immédiate.` };
  }
  if (criticalCount > 0 || highCount >= 3) {
    return { platform_health: "at_risk", global_assessment: `${criticalCount + highCount} incidents de haute sévérité. Surveillance renforcée.` };
  }
  if (incidents.length > 0) {
    return { platform_health: "at_risk", global_assessment: `${incidents.length} incident(s). Sous contrôle.` };
  }
  return { platform_health: "safe", global_assessment: "Aucune menace. Plateforme sécurisée." };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const { requireAdmin } = await import("../_shared/auth-guard.ts");
  const guard = await requireAdmin(req, corsHeaders);
  if (!("userId" in guard)) return guard.response;

  const scanStart = performance.now();
  const scanId = crypto.randomUUID().slice(0, 8);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const past24h = new Date(Date.now() - 24 * 3600000).toISOString();

    const [
      { data: ddosEvents },
      { data: bannedIps },
      { data: abuseReports },
      { data: auditLogs },
      { data: fingerprints },
      { data: existingPatterns },
      { data: alertConfig },
      { data: recentIncidents },
      { data: pastIncidents24h },
    ] = await Promise.all([
      supabase.from("ddos_ip_tracker").select("*").gte("updated_at", since).order("updated_at", { ascending: false }).limit(50),
      supabase.from("banned_ips").select("*").eq("is_active", true).gte("banned_at", since),
      supabase.from("abuse_reports").select("*").gte("created_at", since),
      supabase.from("audit_logs").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(200),
      supabase.from("device_fingerprints").select("fingerprint_hash, ip_address, user_id, last_seen_at").gte("last_seen_at", since),
      supabase.from("security_ai_patterns").select("*").eq("is_active", true).order("confidence", { ascending: false }).limit(50),
      supabase.from("security_alert_config").select("*").eq("is_active", true).limit(1).maybeSingle(),
      supabase.from("security_incidents").select("incident_type, source_ip, created_at").gte("created_at", since).limit(200),
      supabase.from("security_incidents").select("incident_type, source_ip").gte("created_at", past24h).limit(500),
    ]);

    // Dedup set
    const dedupSet = new Set<string>();
    recentIncidents?.forEach(ri => dedupSet.add(`${ri.incident_type}::${ri.source_ip || "none"}`));
    const isDuplicate = (type: string, ip: string | null) => dedupSet.has(`${type}::${ip || "none"}`);

    // Build knowledge from past incidents (proximity scoring)
    const pastIncidentTypes = new Map<string, number>();
    pastIncidents24h?.forEach(pi => {
      pastIncidentTypes.set(pi.incident_type, (pastIncidentTypes.get(pi.incident_type) || 0) + 1);
    });

    // Known bad IPs (banned)
    const knownBadIps = new Set<string>((bannedIps || []).map((b: any) => b.ip_address));

    // ── 3. Heuristic detection with confidence scoring ──
    const incidents: DetectedIncident[] = [];
    let geminiCalls = 0;

    // DDoS
    const blockedIps = ddosEvents?.filter(e => e.blocked_until && new Date(e.blocked_until) > new Date()) || [];
    for (const ev of blockedIps) {
      if (isDuplicate("ddos_attempt", ev.ip_address)) continue;
      const factors: ConfidenceFactors = {
        ip_reputation: knownBadIps.has(ev.ip_address) ? 1.0 : 0.5,
        frequency: Math.min(1, ev.request_count / 500),
        fingerprint_anomaly: 0,
        pattern_match: 0,
        proximity_to_past: pastIncidentTypes.has("ddos_attempt") ? 0.7 : 0,
        behavior_anomaly: ev.penalty_level >= 3 ? 0.9 : 0.4,
        reputation_score: 0.5,
      };
      const confScore = computeConfidenceScore(factors);
      incidents.push({
        incident_type: "ddos_attempt",
        severity: ev.penalty_level >= 4 ? "critical" : ev.penalty_level >= 2 ? "high" : "medium",
        source_ip: ev.ip_address,
        target_endpoint: ev.endpoint,
        attack_vector: "HTTP flood",
        success: false,
        vulnerability_found: null,
        raw_data: { request_count: ev.request_count, penalty_level: ev.penalty_level, blocked_until: ev.blocked_until },
        confidence_score: confScore,
        confidence_factors: factors,
        autonomy_level: 1,
        detection_source: "heuristic",
      });
    }

    // Multi-account
    const fpMap: Record<string, Set<string>> = {};
    fingerprints?.forEach(fp => {
      if (!fpMap[fp.fingerprint_hash]) fpMap[fp.fingerprint_hash] = new Set();
      fpMap[fp.fingerprint_hash].add(fp.user_id);
    });
    for (const [hash, users] of Object.entries(fpMap)) {
      if (users.size > 3 && !isDuplicate("multi_account", null)) {
        const factors: ConfidenceFactors = {
          ip_reputation: 0.2,
          frequency: Math.min(1, users.size / 10),
          fingerprint_anomaly: 1.0,
          pattern_match: 0,
          proximity_to_past: pastIncidentTypes.has("multi_account") ? 0.6 : 0,
          behavior_anomaly: 0.8,
          reputation_score: 0.5,
        };
        incidents.push({
          incident_type: "multi_account",
          severity: users.size > 10 ? "critical" : "high",
          source_ip: null,
          target_endpoint: null,
          attack_vector: "Device fingerprint sharing",
          success: true,
          vulnerability_found: `Same fingerprint used by ${users.size} accounts`,
          raw_data: { fingerprint: hash, user_count: users.size, user_ids: [...users].slice(0, 20) },
          confidence_score: computeConfidenceScore(factors),
          confidence_factors: factors,
          autonomy_level: 1,
          detection_source: "heuristic",
        });
      }
    }

    // Brute force
    const loginFailures = auditLogs?.filter(l => l.event_type === "login_failed") || [];
    const ipLoginAttempts: Record<string, number> = {};
    loginFailures.forEach(l => {
      const ip = (l.metadata as any)?.ip || "unknown";
      ipLoginAttempts[ip] = (ipLoginAttempts[ip] || 0) + 1;
    });
    for (const [ip, count] of Object.entries(ipLoginAttempts)) {
      if (count >= 5 && !isDuplicate("brute_force", ip)) {
        const factors: ConfidenceFactors = {
          ip_reputation: knownBadIps.has(ip) ? 1.0 : 0.3,
          frequency: Math.min(1, count / 20),
          fingerprint_anomaly: 0,
          pattern_match: 0,
          proximity_to_past: pastIncidentTypes.has("brute_force") ? 0.8 : 0,
          behavior_anomaly: count >= 15 ? 0.9 : 0.5,
          reputation_score: 0.5,
        };
        incidents.push({
          incident_type: "brute_force",
          severity: count >= 20 ? "critical" : "high",
          source_ip: ip,
          target_endpoint: null,
          attack_vector: "Credential stuffing / brute force",
          success: false,
          vulnerability_found: null,
          raw_data: { attempts: count, window: "10min" },
          confidence_score: computeConfidenceScore(factors),
          confidence_factors: factors,
          autonomy_level: 1,
          detection_source: "heuristic",
        });
      }
    }

    // Abuse surge
    if (abuseReports && abuseReports.length > 5 && !isDuplicate("abuse_surge", null)) {
      const factors: ConfidenceFactors = {
        ip_reputation: 0,
        frequency: Math.min(1, abuseReports.length / 20),
        fingerprint_anomaly: 0,
        pattern_match: 0,
        proximity_to_past: pastIncidentTypes.has("abuse_surge") ? 0.5 : 0,
        behavior_anomaly: 0.7,
        reputation_score: 0.3,
      };
      incidents.push({
        incident_type: "abuse_surge",
        severity: abuseReports.length > 20 ? "high" : "medium",
        source_ip: null,
        target_endpoint: null,
        attack_vector: "Social engineering / content abuse",
        success: true,
        vulnerability_found: "High volume abuse reports — active harassment campaign",
        raw_data: { report_count: abuseReports.length },
        confidence_score: computeConfidenceScore(factors),
        confidence_factors: factors,
        autonomy_level: 1,
        detection_source: "heuristic",
      });
    }

    // ── 4. LOCAL PATTERN MATCHING (autonomous) ──
    const patternDetections = localPatternMatch(
      existingPatterns || [],
      ddosEvents || [],
      fingerprints || [],
      auditLogs || [],
      knownBadIps,
      pastIncidentTypes,
    );

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
          confirmed_count: (pattern.confirmed_count || 0) + 1,
          last_matched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          // Promote autonomy level if pattern is highly confirmed
          autonomy_level: (pattern.confirmed_count || 0) + 1 >= 3 && (pattern.confidence || 0) >= 0.8 ? 3 : 
                          (pattern.confirmed_count || 0) + 1 >= 1 ? 2 : 1,
        }).eq("id", pid);
      }
    }

    // Decay stale patterns
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const stalePatterns = existingPatterns?.filter(
      p => p.last_matched_at && p.last_matched_at < sevenDaysAgo && p.confidence > 0.1
    ) || [];
    for (const sp of stalePatterns) {
      await supabase.from("security_ai_patterns").update({
        confidence: Math.max(0.05, (sp.confidence || 0.5) - 0.03),
        autonomy_level: 1,
        updated_at: new Date().toISOString(),
      }).eq("id", sp.id);
    }

    // ── 5. Heuristic assessment ──
    const heuristic = heuristicAnalysis(incidents);
    let aiAnalysis: any = null;
    let usedAI = false;

    // ── ÉTAPE 3 : Only call Gemini for ambiguous cases (Level 2) ──
    const ambiguousIncidents = incidents.filter(i => i.autonomy_level === 2);
    const level3Blocks = incidents.filter(i => i.autonomy_level === 3);

    // Only call Gemini if there are ambiguous cases OR new unclassified incidents
    const needsAI = ambiguousIncidents.length > 0 || (incidents.length > 0 && patternDetections.length < incidents.length);

    if (needsAI && incidents.length > 0 && LOVABLE_API_KEY) {
      geminiCalls = 1;
      const patternsContext = existingPatterns?.map(
        p => `[${p.pattern_name}] conf:${p.confidence} matches:${p.times_matched} lvl:${p.autonomy_level || 1} confirmed:${p.confirmed_count || 0} sig:${JSON.stringify(p.pattern_signature)}`
      ).join("\n") || "None";

      const prompt = `Tu es l'IA SOC de Forsure. Analyse ces incidents et FORME le moteur local.

INCIDENTS (${incidents.length}, dont ${ambiguousIncidents.length} ambigus, ${level3Blocks.length} auto-bloqués):
${JSON.stringify(incidents.map((inc, i) => ({
  index: i,
  type: inc.incident_type,
  severity: inc.severity,
  ip: inc.source_ip,
  vector: inc.attack_vector,
  confidence: inc.confidence_score,
  factors: inc.confidence_factors,
  autonomy_level: inc.autonomy_level,
  detection_source: inc.detection_source,
})), null, 2)}

PATTERNS EXISTANTS:
${patternsContext}

STATS (10 min):
- DDoS bloqués: ${blockedIps.length}
- Rapports abus: ${abuseReports?.length || 0}
- Détections locales: ${patternDetections.length}/${incidents.length}
- Auto-blocks (Level 3): ${level3Blocks.length}

ÉTAPE 1 — Structure chaque menace avec:
- type d'attaque, niveau de confiance, contexte, faux positif/négatif potentiel, action efficace

ÉTAPE 2 — Ajuste les scores de confiance des incidents ambigus

Pour chaque new_pattern: signature DOIT contenir "type" parmi: "ip_reputation", "fingerprint_anomaly", "brute_force", "request_spike" + seuils numériques.

JSON:
{
  "incidents_analysis": [{"index":N, "threat_level":"critical|high|medium|low", "attack_succeeded":bool, "vulnerability_description":str|null, "recommendation":str, "confidence_adjustment":float|null, "false_positive_likelihood":float, "attack_category":str}],
  "new_patterns": [{"pattern_name":str, "detection_rule":str, "severity":str, "confidence":float, "signature":{"type":"...", ...thresholds}}],
  "pattern_updates": [{"pattern_name":str, "new_confidence":float, "updated_signature":{...}}],
  "global_threat_assessment": str,
  "platform_health": "safe|at_risk|under_attack",
  "self_improvement_notes": str,
  "autonomy_score": float,
  "quality_feedback": {"estimated_false_positive_rate":float, "estimated_detection_rate":float, "improvement_areas":str[]}
}`;

      try {
        const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: "Tu es une IA SOC. Mission: FORMER le moteur local pour autonomie. Chaque pattern doit être exploitable sans IA. JSON valide uniquement." },
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
            } catch { console.warn("AI JSON parse failed, heuristics only"); }
          }
        }
      } catch (e) {
        console.error("AI error, falling back:", e);
      }
    }

    // ── 7. Store incidents with enriched data ──
    const storedIncidents: string[] = [];
    for (let i = 0; i < incidents.length; i++) {
      const inc = incidents[i];
      const analysis = aiAnalysis?.incidents_analysis?.find((a: any) => a.index === i);

      const { data: inserted } = await supabase.from("security_incidents").insert({
        incident_type: inc.incident_type,
        severity: analysis?.threat_level || inc.severity,
        status: inc.autonomy_level === 3 ? "auto_blocked" : "detected",
        source_ip: inc.source_ip || null,
        target_endpoint: inc.target_endpoint || null,
        attack_vector: inc.attack_vector,
        success: analysis?.attack_succeeded ?? inc.success,
        vulnerability_found: analysis?.vulnerability_description || inc.vulnerability_found,
        ai_analysis: analysis ? JSON.stringify(analysis) : (inc.matched_pattern_id ? JSON.stringify({ local_pattern: true, pattern_id: inc.matched_pattern_id }) : null),
        ai_recommendation: analysis?.recommendation || (inc.autonomy_level === 3 ? "Auto-bloqué par pattern confirmé (Level 3)" : inc.matched_pattern_id ? "Détecté par pattern local" : null),
        raw_data: inc.raw_data,
        confidence_score: inc.confidence_score,
        confidence_factors: inc.confidence_factors,
        autonomy_level: inc.autonomy_level,
        detection_source: inc.detection_source,
      }).select("id").single();

      if (inserted) storedIncidents.push(inserted.id);
    }

    // ── 8. Learn new patterns ──
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
            autonomy_level: 1,
          });
          patternsLearned++;
        }
      }
    }

    if (aiAnalysis?.pattern_updates?.length > 0) {
      for (const update of aiAnalysis.pattern_updates) {
        if (!update.pattern_name) continue;
        const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (update.new_confidence != null) updateData.confidence = Math.min(1, Math.max(0.05, update.new_confidence));
        if (update.updated_signature) updateData.pattern_signature = update.updated_signature;
        await supabase.from("security_ai_patterns").update(updateData).eq("pattern_name", update.pattern_name);
      }
    }

    // ── ÉTAPE 4 : Quality metrics ──
    const reactionTime = Math.round(performance.now() - scanStart);
    // Autonomy = incidents handled WITHOUT Gemini (Level 1 + Level 3) / total
    const handledWithoutAI = incidents.filter(i => i.autonomy_level !== 2).length;
    const autonomyScore = incidents.length > 0 ? handledWithoutAI / incidents.length : 1.0;
    const detectionRate = incidents.length > 0 ? 1.0 : 0; // No ground truth yet, will improve with human verification

    await supabase.from("security_quality_metrics").insert({
      scan_id: scanId,
      total_incidents: incidents.length,
      local_detections: patternDetections.length,
      ai_detections: ambiguousIncidents.length,
      false_positives: 0, // Updated when admin marks false positive
      false_negatives: 0, // Updated when missed threat detected later
      confirmed_threats: level3Blocks.length,
      reaction_time_ms: reactionTime,
      ai_cost_saved: !usedAI,
      autonomy_level: level3Blocks.length > 0 ? 3 : ambiguousIncidents.length > 0 ? 2 : 1,
      autonomy_score: autonomyScore,
      detection_rate: detectionRate,
      patterns_used: matchedPatternIds.size,
      patterns_learned: patternsLearned,
      gemini_calls: geminiCalls,
      metadata: {
        ai_quality_feedback: aiAnalysis?.quality_feedback || null,
        self_improvement: aiAnalysis?.self_improvement_notes || null,
        level3_count: level3Blocks.length,
        ambiguous_count: ambiguousIncidents.length,
      },
    });

    // ── 9. Email alert ──
    const finalHealth = aiAnalysis?.platform_health || heuristic.platform_health;
    const finalAssessment = aiAnalysis?.global_threat_assessment || heuristic.global_assessment;

    const criticalWithIndex = incidents
      .map((inc, originalIdx) => ({ inc, originalIdx }))
      .filter(({ inc, originalIdx }) => {
        const analysis = aiAnalysis?.incidents_analysis?.find((a: any) => a.index === originalIdx);
        const sev = analysis?.threat_level || inc.severity;
        return sev === "critical" || sev === "high";
      });

    if (criticalWithIndex.length > 0 && alertConfig?.alert_email) {
      const emailBody = `🚨 ALERTE SÉCURITÉ FORSURE

${finalHealth === "under_attack" ? "⚠️ PLATEFORME SOUS ATTAQUE" : "⚡ Incidents détectés"}

📊 ${finalAssessment}

🤖 Mode: ${usedAI ? "IA + Local" : "100% Autonome"}
📈 Autonomie: ${Math.round(autonomyScore * 100)}% | Réaction: ${reactionTime}ms
🔒 Auto-blocks (Niv.3): ${level3Blocks.length} | Ambigus (Niv.2): ${ambiguousIncidents.length}

📋 Détails (${criticalWithIndex.length} critiques/hauts):
${criticalWithIndex.map(({ inc, originalIdx }) => {
  const analysis = aiAnalysis?.incidents_analysis?.find((a: any) => a.index === originalIdx);
  const succeeded = analysis?.attack_succeeded ?? inc.success;
  return `
━━━━━━━━━━━━━━━━━
🔴 ${inc.incident_type.toUpperCase()} [Confiance: ${Math.round(inc.confidence_score * 100)}%] [Niv.${inc.autonomy_level}]
   Sévérité: ${analysis?.threat_level || inc.severity}
   IP: ${inc.source_ip || "N/A"} | Source: ${inc.detection_source}
   Résultat: ${succeeded ? "⚠️ RÉUSSIE" : "✅ BLOQUÉE"}${succeeded ? `\n   🔓 FAILLE: ${analysis?.vulnerability_description || inc.vulnerability_found || "En cours"}` : ""}
   💡 ${analysis?.recommendation || "Vérifier les logs"}`;
}).join("\n")}

🧠 ${aiAnalysis?.self_improvement_notes || "Patterns mis à jour via heuristiques"}
🕐 ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}

— Forsure Security AI (Scan ${scanId})`;

      try {
        await supabase.rpc("enqueue_email", {
          queue_name: "transactional_emails",
          payload: {
            to: alertConfig.alert_email,
            subject: `🚨 Forsure — ${criticalWithIndex.length} incident(s) [Autonomie ${Math.round(autonomyScore * 100)}%]`,
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
      scan_id: scanId,
      incidents_detected: incidents.length,
      incidents_stored: storedIncidents.length,
      local_detections: patternDetections.length,
      auto_blocks: level3Blocks.length,
      ambiguous_cases: ambiguousIncidents.length,
      ai_used: usedAI,
      gemini_calls: geminiCalls,
      patterns_learned: patternsLearned,
      patterns_total: (existingPatterns?.length || 0) + patternsLearned,
      platform_health: finalHealth,
      alert_sent: criticalWithIndex.length > 0 && !!alertConfig?.alert_email,
      global_assessment: finalAssessment,
      autonomy_score: autonomyScore,
      autonomy_level: level3Blocks.length > 0 ? 3 : ambiguousIncidents.length > 0 ? 2 : 1,
      reaction_time_ms: reactionTime,
      quality: {
        detection_rate: detectionRate,
        ai_feedback: aiAnalysis?.quality_feedback || null,
        cost_saved: !usedAI,
      },
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
