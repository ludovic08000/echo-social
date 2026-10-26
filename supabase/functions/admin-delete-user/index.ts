import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuthenticated } from "../_shared/auth-guard.ts";
import { getCorsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  const reply = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "Méthode non autorisée" });

  try {
    // Un secret de service ne remplace pas l'identité de l'administrateur humain.
    const caller = await requireAuthenticated(req, corsHeaders);
    if (!caller.ok) return caller.response;
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const role = await admin.rpc("has_role", { _user_id: caller.userId, _role: "admin" });
    if (role.error || role.data !== true) return reply(403, { error: "Accès admin requis" });

    let body: unknown;
    try { body = await req.json(); } catch { return reply(400, { error: "Requête JSON invalide" }); }
    const target = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).target_user_id : null;
    if (typeof target !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
      return reply(400, { error: "Identifiant de compte invalide" });
    }
    const targetId = target.toLowerCase();
    if (targetId === caller.userId.toLowerCase()) return reply(400, { error: "Impossible de supprimer votre propre compte" });
    if (targetId === "00000000-0000-0000-0000-000000000001") return reply(403, { error: "Compte système protégé" });

    // Auth supprime dans sa transaction : ses cascades sont atomiques. Ne jamais
    // pré-effacer profils/messages pour contourner une clé étrangère bloquante.
    const deleted = await admin.auth.admin.deleteUser(targetId, false);
    if (deleted.error) {
      if (deleted.error.status === 404 && deleted.error.code === "user_not_found") {
        return reply(404, { error: "Compte introuvable ; aucune nouvelle suppression confirmée" });
      }
      return reply(503, { error: "Suppression non confirmée par Auth. Vérifiez le compte avant de réessayer.", code: "ACCOUNT_DELETION_NOT_CONFIRMED" });
    }

    // La réponse Auth de suppression peut être vide. Seul un vrai 404 de relecture
    // prouve ici la disparition du compte, pas un résultat nul ni une erreur réseau.
    const checked = await admin.auth.admin.getUserById(targetId);
    const absent = checked.error?.status === 404 && checked.error.code === "user_not_found";
    if (!absent || checked.data?.user) {
      return reply(503, { error: "Résultat de suppression inconnu. Vérifiez le compte côté serveur avant toute reprise.", code: "ACCOUNT_DELETION_UNKNOWN" });
    }
    return reply(200, {
      success: true, auth_deleted: true, storage_cleanup: "not_performed",
      message: "Suppression du compte confirmée par Auth. Les données liées suivent les contraintes de la base ; les fichiers et rétentions externes nécessitent un traitement distinct.",
    });
  } catch {
    // Une réponse perdue peut suivre un commit : ne jamais prétendre « rien supprimé ».
    return reply(503, { error: "Résultat de suppression non confirmé. Vérifiez le compte avant de réessayer.", code: "ACCOUNT_DELETION_UNKNOWN" });
  }
});
