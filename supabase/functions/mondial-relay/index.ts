import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { crypto } from "https://deno.land/std@0.190.0/crypto/mod.ts";
import { encode as hexEncode } from "https://deno.land/std@0.190.0/encoding/hex.ts";

const MR_WSDL = "https://api.mondialrelay.com/Web_Services.asmx";
const MR_V2_BASE = "https://connect-api.mondialrelay.com/api";

// ── SOAP helpers (used for search_points & tracking which work fine) ──

function md5Hex(str: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = crypto.subtle.digestSync("MD5", data);
  const hashArray = new Uint8Array(hashBuffer);
  return new TextDecoder().decode(hexEncode(hashArray)).toUpperCase();
}

function buildSignatureFromOrderedFields(
  orderedValues: string[],
  privateKey: string,
): string {
  return md5Hex(orderedValues.join('') + privateKey);
}

async function callMondialRelaySoap(method: string, params: Record<string, string>): Promise<string> {
  const soapParams = Object.entries(params)
    .map(([k, v]) => `<${k}>${esc(String(v ?? ""))}</${k}>`)
    .join('');

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${method} xmlns="http://www.mondialrelay.fr/webservice/">
      ${soapParams}
    </${method}>
  </soap:Body>
</soap:Envelope>`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(MR_WSDL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": `http://www.mondialrelay.fr/webservice/${method}`,
      },
      body: soapBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Mondial Relay SOAP error ${response.status}: ${text.substring(0, 500)}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractXmlValue(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function extractRelayPoints(xml: string): any[] {
  const points: any[] = [];
  const pointRegex = /<PointRelais_Details>([\s\S]*?)<\/PointRelais_Details>/gi;
  let match;
  while ((match = pointRegex.exec(xml)) !== null) {
    const block = match[1];
    points.push({
      id: extractXmlValue(block, 'Num'),
      name: extractXmlValue(block, 'LgAdr1'),
      address: extractXmlValue(block, 'LgAdr3'),
      postcode: extractXmlValue(block, 'CP'),
      city: extractXmlValue(block, 'Ville'),
      country: extractXmlValue(block, 'Pays'),
      latitude: extractXmlValue(block, 'Latitude'),
      longitude: extractXmlValue(block, 'Longitude'),
      distance: extractXmlValue(block, 'Distance'),
      photo_url: extractXmlValue(block, 'URL_Photo'),
      hours_monday: extractXmlValue(block, 'Horaires_Lundi'),
      hours_tuesday: extractXmlValue(block, 'Horaires_Mardi'),
      hours_wednesday: extractXmlValue(block, 'Horaires_Mercredi'),
      hours_thursday: extractXmlValue(block, 'Horaires_Jeudi'),
      hours_friday: extractXmlValue(block, 'Horaires_Vendredi'),
      hours_saturday: extractXmlValue(block, 'Horaires_Samedi'),
      hours_sunday: extractXmlValue(block, 'Horaires_Dimanche'),
    });
  }
  return points;
}

// ── Helper: escape XML special chars ──
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const enseigne = (Deno.env.get("MONDIAL_RELAY_ENSEIGNE") ?? "").trim();
  const privateKey = (Deno.env.get("MONDIAL_RELAY_PRIVATE_KEY") ?? "").trim();

  try {
    const body = await req.json();
    const { action } = body;

    // ── SEARCH RELAY POINTS (SOAP v1 - works fine) ──
    if (action === "search_points") {
      if (!enseigne || !privateKey) {
        throw new Error("Configuration Mondial Relay manquante");
      }

      const rawPostcode = typeof body.postcode === "string" ? body.postcode : "";
      const rawCountry = typeof body.country === "string" ? body.country : "FR";
      const postcode = rawPostcode.trim();
      const country = rawCountry.trim().toUpperCase() || "FR";
      if (!postcode) throw new Error("Code postal requis");

      const params: Record<string, string> = {
        Enseigne: enseigne,
        Pays: country,
        CP: postcode,
        Latitude: '',
        Longitude: '',
        Taille: '',
        Poids: '',
        Action: '',
        DelaiEnvoi: '0',
        RayonRecherche: '',
        TypeActivite: '',
        NACE: '',
        NombreResultats: '20',
      };

      const searchOrderedValues = [
        enseigne, country, postcode,
        '', '', '', '', '', '0', '', '', '', '20',
      ];
      params.Security = buildSignatureFromOrderedFields(searchOrderedValues, privateKey);

      const xml = await callMondialRelaySoap("WSI4_PointRelais_Recherche", params);
      const stat = extractXmlValue(xml, 'STAT');

      if (stat !== '0') {
        const detail = extractXmlValue(xml, 'Erreur') || extractXmlValue(xml, 'Message') || '';
        throw new Error(`Mondial Relay erreur code ${stat}${detail ? `: ${detail}` : ''}`);
      }

      const points = extractRelayPoints(xml);

      return new Response(JSON.stringify({ points }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── CREATE SHIPMENT (SOAP v1 - WSI2_CreationEtiquette) ──
    if (action === "create_shipment") {
      if (!enseigne || !privateKey) {
        throw new Error("Configuration Mondial Relay manquante");
      }

      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) throw new Error("Non authentifié");

      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

      // Verify JWT and identify caller
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const token = authHeader.replace("Bearer ", "");
      const { data: claims, error: authError } = await userClient.auth.getClaims(token);
      if (authError || !claims?.claims?.sub) {
        return new Response(JSON.stringify({ error: "Non authentifié" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const callerId = claims.claims.sub as string;

      const supabase = createClient(supabaseUrl, serviceKey);

      const { order_id, sender, relay_id } = body;
      const shipment = body?.package ?? {};
      if (!order_id) throw new Error("order_id requis");

      // Get order + items with seller info
      const { data: order } = await supabase
        .from("orders")
        .select("*, order_items(*, products(seller_id))")
        .eq("id", order_id)
        .single();

      if (!order) throw new Error("Commande introuvable");

      // Verify caller is a seller on this order
      const sellerIds = new Set<string>(
        (order.order_items ?? [])
          .map((it: any) => it?.products?.seller_id)
          .filter(Boolean),
      );
      if (!sellerIds.has(callerId)) {
        return new Response(JSON.stringify({ error: "Accès refusé" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const parsedWeight = Number(shipment.weight_grams);
      const weight = Number.isFinite(parsedWeight) && parsedWeight > 0
        ? Math.round(parsedWeight)
        : (order.shipping_weight_grams || 500);

      const senderName = sender?.name || "Vendeur ForSure";
      const senderAddress = sender?.address || "10 RUE DE TEST";
      const senderCity = sender?.city || "PARIS";
      const senderPostcode = sender?.postcode || "75001";
      const senderCountry = sender?.country || "FR";
      const senderPhone = sender?.phone || "0600000000";
      const senderEmail = sender?.email || "support@forsure.app";

      const recipientName = order.shipping_relay_name || "Client";
      const recipientAddress = order.shipping_relay_address || "";
      const recipientCity = order.shipping_relay_city || "";
      const recipientPostcode = order.shipping_relay_postcode || "";
      const recipientCountry = order.shipping_relay_country || "FR";

      const orderNo = order.order_number || `ORD-${order_id.substring(0, 8)}`;

      // Clean relay ID
      const rawRelayId = order.shipping_relay_id || relay_id || "";
      const cleanRelayId = String(rawRelayId).replace(/[^0-9]/g, '');
      const relayCountry = String(recipientCountry).trim().toUpperCase() || "FR";

      const deliveryMode = (body?.delivery_mode || "24R").trim().toUpperCase();
      const collectionMode = (body?.collection_mode || "CCC").trim().toUpperCase();

      const allowedDeliveryModes = ["24R", "24L", "LCC"];
      if (!allowedDeliveryModes.includes(deliveryMode)) {
        throw new Error(`ModeLiv invalide: ${deliveryMode}`);
      }

      // Format phone: digits only, max 10
      const formatPhone = (phone: string): string => {
        return phone.replace(/[^0-9]/g, '').substring(0, 10) || "0600000000";
      };

      // Relay location fields
      const livRelayId = ["24R", "24L"].includes(deliveryMode) ? cleanRelayId : "";
      const colRelayId = collectionMode === "REL" ? cleanRelayId : "";
      const insuranceValue = Math.round(order.subtotal * 100);

      // Validate required fields before SOAP call
      if (!recipientName) throw new Error("Nom destinataire manquant");
      if (!recipientPostcode) throw new Error("Code postal destinataire manquant");
      if (!recipientCity) throw new Error("Ville destinataire manquante");
      if (!relayCountry) throw new Error("Pays destinataire manquant");
      if (["24R", "24L"].includes(deliveryMode) && !cleanRelayId) {
        throw new Error("Point relais manquant");
      }
      if (!senderName) throw new Error("Nom expéditeur manquant");
      if (!senderAddress) throw new Error("Adresse expéditeur manquante");
      if (!senderPostcode) throw new Error("Code postal expéditeur manquant");
      if (!senderCity) throw new Error("Ville expéditeur manquante");
      if (!weight || weight <= 0) throw new Error("Poids invalide");

      // Build SOAP params for WSI2_CreationEtiquette
      // Values must be RAW (no XML escaping) - the SOAP helper handles XML construction
      // Order matters for MD5 signature computation
      const params: Record<string, string> = {
        Enseigne: enseigne,
        ModeCol: collectionMode,
        ModeLiv: deliveryMode,
        NDossier: orderNo.replace(/[^0-9A-Za-z_ -]/g, '').substring(0, 15),
        NClient: orderNo.replace(/[^0-9A-Za-z_ -]/g, '').substring(0, 9),
        Expe_Langage: 'FR',
        Expe_Ad1: senderName.replace(/[^0-9A-Za-zÀ-ÿ .'/-]/g, '').substring(0, 32),
        Expe_Ad2: '',
        Expe_Ad3: senderAddress.replace(/[^0-9A-Za-zÀ-ÿ .'/-]/g, '').substring(0, 32),
        Expe_Ad4: '',
        Expe_Ville: senderCity.replace(/[^A-Za-zÀ-ÿ -]/g, '').substring(0, 26),
        Expe_CP: senderPostcode,
        Expe_Pays: senderCountry.substring(0, 2).toUpperCase(),
        Expe_Tel1: formatPhone(senderPhone),
        Expe_Tel2: '',
        Expe_Mail: senderEmail.substring(0, 70),
        Dest_Langage: 'FR',
        Dest_Ad1: recipientName.replace(/[^0-9A-Za-zÀ-ÿ .'/-]/g, '').substring(0, 32),
        Dest_Ad2: '',
        Dest_Ad3: recipientAddress.replace(/[^0-9A-Za-zÀ-ÿ .'/-]/g, '').substring(0, 32),
        Dest_Ad4: '',
        Dest_Ville: recipientCity.replace(/[^A-Za-zÀ-ÿ -]/g, '').substring(0, 26),
        Dest_CP: recipientPostcode,
        Dest_Pays: relayCountry,
        Dest_Tel1: '',
        Dest_Tel2: '',
        Dest_Mail: '',
        Poids: String(weight),
        Longueur: '',
        Taille: '',
        NbColis: '1',
        CRT_Valeur: String(insuranceValue),
        CRT_Devise: 'EUR',
        Exp_Valeur: '',
        Exp_Devise: '',
        COL_Rel_Pays: colRelayId ? relayCountry : '',
        COL_Rel: colRelayId,
        LIV_Rel_Pays: livRelayId ? relayCountry : '',
        LIV_Rel: livRelayId,
        TAvisage: '',
        TReprise: '',
        Montage: '',
        TRDV: '',
        Assurance: '',
        Instructions: '',
        Texte: '',
      };

      // Compute MD5 signature: explicit WSDL-ordered values + private key
      const shipmentOrderedValues = [
        params.Enseigne, params.ModeCol, params.ModeLiv,
        params.NDossier, params.NClient,
        params.Expe_Langage, params.Expe_Ad1, params.Expe_Ad2, params.Expe_Ad3, params.Expe_Ad4,
        params.Expe_Ville, params.Expe_CP, params.Expe_Pays,
        params.Expe_Tel1, params.Expe_Tel2, params.Expe_Mail,
        params.Dest_Langage, params.Dest_Ad1, params.Dest_Ad2, params.Dest_Ad3, params.Dest_Ad4,
        params.Dest_Ville, params.Dest_CP, params.Dest_Pays,
        params.Dest_Tel1, params.Dest_Tel2, params.Dest_Mail,
        params.Poids, params.Longueur, params.Taille, params.NbColis,
        params.CRT_Valeur, params.CRT_Devise,
        params.Exp_Valeur, params.Exp_Devise,
        params.COL_Rel_Pays, params.COL_Rel,
        params.LIV_Rel_Pays, params.LIV_Rel,
        params.TAvisage, params.TReprise, params.Montage, params.TRDV,
        params.Assurance, params.Instructions,
        // Texte est exclu du calcul de signature
      ];
      params.Security = buildSignatureFromOrderedFields(shipmentOrderedValues, privateKey);

      console.log("SOAP create_shipment - enseigne:", enseigne, "order:", orderNo);

      const xml = await callMondialRelaySoap("WSI2_CreationEtiquette", params);
      const stat = extractXmlValue(xml, 'STAT');

      if (stat !== '0' && stat !== '') {
        const errorDetail = extractXmlValue(xml, 'Erreur') || extractXmlValue(xml, 'Message') || '';
        console.error("SOAP create label error:", { stat, errorDetail, xml: xml.substring(0, 1000) });
        throw new Error(`Mondial Relay erreur création étiquette (code ${stat})${errorDetail ? ` : ${errorDetail}` : ''}`);
      }

      const expeditionNum = extractXmlValue(xml, 'ExpeditionNum');
      let labelUrl = extractXmlValue(xml, 'URL_Etiquette');

      if (!expeditionNum) {
        console.error("No expedition number in SOAP response:", xml.substring(0, 2000));
        throw new Error("Numéro d'expédition non trouvé dans la réponse");
      }

      // Make label URL absolute
      if (labelUrl && !labelUrl.startsWith('http')) {
        labelUrl = `https://www.mondialrelay.fr${labelUrl}`;
      }

      // Update order
      await supabase
        .from("orders")
        .update({
          tracking_number: expeditionNum,
          shipping_label_url: labelUrl,
          shipping_weight_grams: weight,
          shipped_at: new Date().toISOString(),
          status: "shipped",
        })
        .eq("id", order_id);

      return new Response(JSON.stringify({ tracking_number: expeditionNum, label_url: labelUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── TRACK SHIPMENT (SOAP v1) ──
    if (action === "track") {
      if (!enseigne || !privateKey) {
        throw new Error("Configuration Mondial Relay manquante");
      }

      const { tracking_number } = body;
      if (!tracking_number) throw new Error("Numéro de suivi requis");

      const params: Record<string, string> = {
        Enseigne: enseigne,
        Expedition: tracking_number,
        Langue: 'FR',
      };
      const trackOrderedValues = [enseigne, tracking_number, 'FR'];
      params.Security = buildSignatureFromOrderedFields(trackOrderedValues, privateKey);

      const xml = await callMondialRelaySoap("WSI2_TracingColisDetaille", params);
      const stat = extractXmlValue(xml, 'STAT');

      if (stat !== '0') {
        if (stat === '95') {
          return new Response(JSON.stringify({
            events: [{ date: new Date().toISOString().split("T")[0], status: "En attente de prise en charge", location: "" }],
            tracking_number,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        throw new Error(`Erreur suivi Mondial Relay (code ${stat})`);
      }

      const events: any[] = [];
      const eventRegex = /<ret_WSI2_sub_TracingColisDetworking>([\s\S]*?)<\/ret_WSI2_sub_TracingColisDetworking>/gi;
      let evtMatch;
      while ((evtMatch = eventRegex.exec(xml)) !== null) {
        const block = evtMatch[1];
        events.push({
          date: extractXmlValue(block, 'Date'),
          status: extractXmlValue(block, 'Libelle'),
          location: extractXmlValue(block, 'Lieu'),
        });
      }

      return new Response(JSON.stringify({ events, tracking_number }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Action invalide" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("mondial-relay error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
