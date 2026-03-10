import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { crypto } from "https://deno.land/std@0.190.0/crypto/mod.ts";
import { encode as hexEncode } from "https://deno.land/std@0.190.0/encoding/hex.ts";

const MR_WSDL = "https://api.mondialrelay.com/Web_Services.asmx";
const MR_V2_BASE = "https://api.mondialrelay.com/api/v2";

// ── SOAP helpers (used for search_points & tracking which work fine) ──

function md5Hex(str: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = crypto.subtle.digestSync("MD5", data);
  const hashArray = new Uint8Array(hashBuffer);
  return new TextDecoder().decode(hexEncode(hashArray)).toUpperCase();
}

function buildSignature(params: Record<string, string>, privateKey: string): string {
  const concat = Object.values(params).join('') + privateKey;
  return md5Hex(concat);
}

async function callMondialRelaySoap(method: string, params: Record<string, string>): Promise<string> {
  const soapParams = Object.entries(params)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${method} xmlns="http://www.mondialrelay.fr/webservice/">
      ${soapParams}
    </${method}>
  </soap:Body>
</soap:Envelope>`;

  const response = await fetch(MR_WSDL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `http://www.mondialrelay.fr/webservice/${method}`,
    },
    body: soapBody,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mondial Relay SOAP error ${response.status}: ${text.substring(0, 500)}`);
  }

  return await response.text();
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

// ── V2 REST API helper ──

async function callMondialRelayV2(endpoint: string, method: string, body?: any): Promise<any> {
  const login = (Deno.env.get("MONDIAL_RELAY_V2_LOGIN") ?? "").trim();
  const password = (Deno.env.get("MONDIAL_RELAY_V2_PASSWORD") ?? "").trim();

  if (!login || !password) {
    throw new Error("Configuration Mondial Relay V2 manquante (login/password)");
  }

  const auth = btoa(`${login}:${password}`);
  const url = `${MR_V2_BASE}${endpoint}`;

  console.log(`MR V2 ${method} ${url}`, body ? JSON.stringify(body).substring(0, 500) : '');

  const response = await fetch(url, {
    method,
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();

  if (!response.ok) {
    console.error(`MR V2 error ${response.status}:`, text.substring(0, 1000));
    
    // Try to parse error details
    try {
      const err = JSON.parse(text);
      const msg = err.message || err.Message || err.error || err.Error || text.substring(0, 200);
      throw new Error(`Mondial Relay V2 erreur: ${msg}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Mondial Relay')) throw e;
      throw new Error(`Mondial Relay V2 erreur ${response.status}: ${text.substring(0, 200)}`);
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

      params.Security = buildSignature(params, privateKey);

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

    // ── CREATE SHIPMENT (V2 REST API) ──
    if (action === "create_shipment") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) throw new Error("Non authentifié");

      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const supabase = createClient(supabaseUrl, serviceKey);

      const brandId = (Deno.env.get("MONDIAL_RELAY_V2_BRAND_ID") ?? "").trim();

      const { order_id, sender, relay_id } = body;
      const shipment = body?.package ?? {};
      if (!order_id) throw new Error("order_id requis");

      // Get order
      const { data: order } = await supabase
        .from("orders")
        .select("*, order_items(*)")
        .eq("id", order_id)
        .single();

      if (!order) throw new Error("Commande introuvable");

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

      // Format phone
      const formatPhone = (phone: string): string => {
        return phone.replace(/[^0-9+]/g, '').substring(0, 10) || "0600000000";
      };

      // Build V2 shipment request
      const shipmentBody: any = {
        OutputFormat: "PdfA4",
        OutputType: "QRCode",
        BrandIdAPI: brandId || enseigne,
        Shipments: [
          {
            OrderNo: orderNo.substring(0, 15),
            CollectionMode: {
              Mode: collectionMode,
              ...(collectionMode === "REL" ? { Location: cleanRelayId } : {}),
            },
            DeliveryMode: {
              Mode: deliveryMode,
              ...(["24R", "24L", "DRI"].includes(deliveryMode) ? { Location: cleanRelayId } : {}),
            },
            Sender: {
              Address: {
                Title: "MR",
                Firstname: senderName.substring(0, 20),
                Lastname: senderName.substring(0, 20),
                Streetname: senderAddress.substring(0, 32),
                CountryCode: senderCountry.substring(0, 2).toUpperCase(),
                PostCode: senderPostcode,
                City: senderCity.substring(0, 26),
                AddressAdd1: "",
                AddressAdd2: "",
                AddressAdd3: "",
                PhoneNo: formatPhone(senderPhone),
                Email: senderEmail,
              },
            },
            Recipient: {
              Address: {
                Title: "MR",
                Firstname: recipientName.substring(0, 20),
                Lastname: recipientName.substring(0, 20),
                Streetname: recipientAddress.substring(0, 32),
                CountryCode: relayCountry,
                PostCode: recipientPostcode,
                City: recipientCity.substring(0, 26),
                AddressAdd1: "",
                AddressAdd2: "",
                AddressAdd3: "",
                PhoneNo: "",
                Email: "",
              },
            },
            Parcels: [
              {
                Content: "Marketplace ForSure",
                Weight: {
                  Value: weight,
                  Unit: "gr",
                },
                ...(shipment.length_cm ? {
                  Length: { Value: Number(shipment.length_cm), Unit: "cm" },
                } : {}),
              },
            ],
            Options: {
              Insurance: {
                Value: Math.round(order.subtotal * 100),
                Currency: "EUR",
              },
            },
          },
        ],
      };

      console.log("V2 create_shipment request:", JSON.stringify({
        order_id,
        deliveryMode,
        collectionMode,
        relayId: cleanRelayId,
        relayCountry,
        weight,
        brandId: brandId || enseigne,
      }));

      const result = await callMondialRelayV2("/shipments", "POST", shipmentBody);

      console.log("V2 create_shipment response:", JSON.stringify(result).substring(0, 1000));

      // Extract shipment number and label from V2 response
      let expeditionNum = "";
      let labelUrl: string | null = null;

      if (result?.Shipments && result.Shipments.length > 0) {
        const s = result.Shipments[0];
        expeditionNum = s.ShipmentNumber || s.ExpeditionNum || s.Number || "";
        labelUrl = s.LabelUrl || s.Labels?.[0]?.Url || s.Labels?.[0]?.Output || null;
      } else if (result?.ShipmentNumber) {
        expeditionNum = result.ShipmentNumber;
        labelUrl = result.LabelUrl || null;
      } else if (typeof result === "object") {
        // Try to find expedition number in any field
        const resStr = JSON.stringify(result);
        const numMatch = resStr.match(/"(?:ShipmentNumber|ExpeditionNum|Number)"\s*:\s*"(\d+)"/i);
        if (numMatch) expeditionNum = numMatch[1];
      }

      if (!expeditionNum) {
        console.error("No expedition number in V2 response:", JSON.stringify(result).substring(0, 2000));
        throw new Error("Numéro d'expédition non trouvé dans la réponse V2");
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
      params.Security = buildSignature(params, privateKey);

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
