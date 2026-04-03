import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    // 1. Collect security data from last 10 minutes
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const [
      { data: ddosEvents },
      { data: bannedIps },
      { data: abuseReports },
      { data: auditLogs },
      { data: fingerprints },
      { data: existingPatterns },
      { data: alertConfig },
    ] = await Promise.all([
      supabase.from("ddos_ip_tracker").select("*").gte("updated_at", since).order("updated_at", { ascending: false }).limit(50),
      supabase.from("banned_ips").select("*").eq("is_active", true).gte("banned_at", since),
      supabase.from("abuse_reports").select("*").gte("created_at", since),
      supabase.from("audit_logs").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(200),
      supabase.from("device_fingerprints").select("fingerprint_hash, ip_address, user_id, last_seen_at").gte("last_seen_at", since),
      supabase.from("security_ai_patterns").select("*").eq("is_active", true).order("confidence", { ascending: false }).limit(50),
      supabase.from("security_alert_config").select("*").eq("is_active", true).limit(1).maybeSingle(),
    ]);

    // 2. Detect incidents from data
    const incidents: any[] = [];

    // DDoS detections
    const blockedIps = ddosEvents?.filter(e => e.blocked_until && new Date(e.blocked_until) > new Date()) || [];
    for (const ev of blockedIps) {
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

    // Multi-account detection (same fingerprint, multiple users)
    const fpMap: Record<string, Set<string>> = {};
    fingerprints?.forEach(fp => {
      if (!fpMap[fp.fingerprint_hash]) fpMap[fp.fingerprint_hash] = new Set();
      fpMap[fp.fingerprint_hash].add(fp.user_id);
    });
    for (const [hash, users] of Object.entries(fpMap)) {
      if (users.size > 3) {
        incidents.push({
          incident_type: "multi_account",
          severity: "high",
          attack_vector: "Device fingerprint sharing",
          success: true,
          vulnerability_found: "Insufficient device binding - same fingerprint used by " + users.size + " accounts",
          raw_data: { fingerprint: hash, user_count: users.size, user_ids: [...users] },
        });
      }
    }

    // Suspicious audit patterns
    const loginFailures = auditLogs?.filter(l => l.event_type === "login_failed") || [];
    const ipLoginAttempts: Record<string, number> = {};
    loginFailures.forEach(l => {
      const ip = (l.metadata as any)?.ip || "unknown";
      ipLoginAttempts[ip] = (ipLoginAttempts[ip] || 0) + 1;
    });
    for (const [ip, count] of Object.entries(ipLoginAttempts)) {
      if (count >= 5) {
        incidents.push({
          incident_type: "brute_force",
          severity: count >= 20 ? "critical" : "high",
          source_ip: ip,
          attack_vector: "Credential stuffing / brute force",
          success: false,
          vulnerability_found: null,
          raw_data: { attempts: count, window: "10min" },
        });
      }
    }

    // Abuse reports surge
    if (abuseReports && abuseReports.length > 5) {
      incidents.push({
        incident_type: "abuse_surge",
        severity: "medium",
        attack_vector: "Social engineering / content abuse",
        success: true,
        vulnerability_found: "High volume of abuse reports suggests active attack or harassment campaign",
        raw_data: { report_count: abuseReports.length },
      });
    }

    // 3. If we have incidents and AI key, analyze with AI
    let aiAnalysis: any = null;
    if (incidents.length > 0 && LOVABLE_API_KEY) {
      const patternsContext = existingPatterns?.map(p => `[${p.pattern_name}] confidence:${p.confidence} rule:"${p.detection_rule}"`).join("\n") || "Aucun pattern appris";

      const prompt = `Tu es une IA de sécurité experte (SIEM/SOC). Analyse ces incidents de sécurité détectés sur la plateforme Forsure.

INCIDENTS DÉTECTÉS:
${JSON.stringify(incidents, null, 2)}

PATTERNS APPRIS PRÉCÉDEMMENT:
${patternsContext}

DONNÉES BRUTES (dernières 10 min):
- IPs bloquées DDoS: ${blockedIps.length}
- Rapports d'abus: ${abuseReports?.length || 0}
- Logs d'audit: ${auditLogs?.length || 0}
- Auto-bans IP: ${bannedIps?.length || 0}

Pour chaque incident, réponds en JSON avec:
1. "incidents_analysis": array de {
  "index": number,
  "threat_level": "critical"|"high"|"medium"|"low",
  "attack_succeeded": boolean,
  "vulnerability_description": string ou null (si attaque réussie, où est la faille exacte),
  "recommendation": string (action corrective précise),
  "related_pattern": string ou null
}
2. "new_patterns": array de patterns à apprendre {
  "pattern_name": string,
  "detection_rule": string (règle en langage naturel),
  "severity": string,
  "confidence": number (0-1),
  "signature": object (critères techniques)
}
3. "global_threat_assessment": string (résumé global de la menace)
4. "platform_health": "safe"|"at_risk"|"under_attack"
5. "self_improvement_notes": string (ce que l'IA a appris de cette analyse pour s'améliorer)

Réponds UNIQUEMENT en JSON valide.`;

      try {
        const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: "Tu es une IA SOC (Security Operations Center) experte. Tu analyses les incidents de sécurité et apprends de chaque analyse pour améliorer ta détection future. Réponds toujours en JSON valide." },
              { role: "user", content: prompt },
            ],
          }),
        });

        if (aiResp.ok) {
          const aiData = await aiResp.json();
          const content = aiData.choices?.[0]?.message?.content || "";
          // Parse JSON from response
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { aiAnalysis = JSON.parse(jsonMatch[0]); } catch { aiAnalysis = { raw: content }; }
          }
        }
      } catch (e) { console.error("AI analysis error:", e); }
    }

    // 4. Store incidents in DB
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
        ai_analysis: analysis ? JSON.stringify(analysis) : null,
        ai_recommendation: analysis?.recommendation || null,
        raw_data: inc.raw_data,
      }).select("id").single();

      if (inserted) storedIncidents.push(inserted.id);
    }

    // 5. Store new AI-learned patterns
    if (aiAnalysis?.new_patterns?.length > 0) {
      for (const pattern of aiAnalysis.new_patterns) {
        // Check if similar pattern already exists
        const { data: existing } = await supabase
          .from("security_ai_patterns")
          .select("id, times_matched, confidence")
          .eq("pattern_name", pattern.pattern_name)
          .maybeSingle();

        if (existing) {
          // Update existing pattern: increase confidence and match count
          await supabase.from("security_ai_patterns").update({
            times_matched: existing.times_matched + 1,
            confidence: Math.min(1, existing.confidence + 0.05),
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
        }
      }
    }

    // 6. Send email alert if critical/high incidents
    const criticalIncidents = incidents.filter((_, i) => {
      const analysis = aiAnalysis?.incidents_analysis?.find((a: any) => a.index === i);
      const sev = analysis?.threat_level || incidents[i].severity;
      return sev === "critical" || sev === "high";
    });

    if (criticalIncidents.length > 0 && alertConfig?.alert_email) {
      const emailBody = `🚨 ALERTE SÉCURITÉ FORSURE

${aiAnalysis?.platform_health === "under_attack" ? "⚠️ PLATEFORME SOUS ATTAQUE" : "⚡ Incidents de sécurité détectés"}

📊 Résumé: ${aiAnalysis?.global_threat_assessment || "Incidents détectés nécessitant attention"}

📋 Détails des incidents (${criticalIncidents.length} critiques/hauts):
${criticalIncidents.map((inc, i) => {
  const analysis = aiAnalysis?.incidents_analysis?.find((a: any) => a.index === i);
  return `
━━━━━━━━━━━━━━━━━━━━━
🔴 ${inc.incident_type.toUpperCase()}
   Sévérité: ${analysis?.threat_level || inc.severity}
   IP source: ${inc.source_ip || "N/A"}
   Vecteur: ${inc.attack_vector}
   Résultat: ${(analysis?.attack_succeeded ?? inc.success) ? "⚠️ ATTAQUE RÉUSSIE" : "✅ ATTAQUE BLOQUÉE"}
   ${(analysis?.attack_succeeded ?? inc.success) ? `🔓 FAILLE: ${analysis?.vulnerability_description || inc.vulnerability_found || "Analyse en cours"}` : ""}
   💡 Action: ${analysis?.recommendation || "Vérifier les logs"}
`;
}).join("")}

🧠 Auto-apprentissage: ${aiAnalysis?.self_improvement_notes || "Patterns mis à jour"}
🕐 ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}

— Forsure Security AI`;

      // Try sending via transactional email if available
      try {
        const emailPayload = {
          to: alertConfig.alert_email,
          subject: `🚨 Alerte Sécurité Forsure — ${criticalIncidents.length} incident(s) ${aiAnalysis?.platform_health === "under_attack" ? "SOUS ATTAQUE" : "détecté(s)"}`,
          body: emailBody,
        };

        // Use the enqueue_email RPC if available
        await supabase.rpc("enqueue_email", {
          queue_name: "transactional_emails",
          payload: {
            to: alertConfig.alert_email,
            subject: emailPayload.subject,
            html: `<pre style="font-family:monospace;white-space:pre-wrap;max-width:600px;margin:0 auto;padding:20px;background:#0a0a0a;color:#e0e0e0;border-radius:12px;">${emailBody}</pre>`,
            purpose: "transactional",
          },
        });

        // Mark incidents as alert sent
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
      patterns_learned: aiAnalysis?.new_patterns?.length || 0,
      platform_health: aiAnalysis?.platform_health || "safe",
      alert_sent: criticalIncidents.length > 0 && !!alertConfig?.alert_email,
      global_assessment: aiAnalysis?.global_threat_assessment || "No threats detected",
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
