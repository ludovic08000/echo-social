import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCorsHeaders } from "../_shared/cors.ts";

const MR_WSDL = "https://api.mondialrelay.com/Web_Services.asmx";

// Compact MD5 implementation (Web Crypto does not support MD5)
function md5Hex(str: string): string {
  function md5cycle(x: number[], k: number[]) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }

  function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & c) | ((~b) & d), a, b, x, s, t);
  }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & d) | (c & (~d)), a, b, x, s, t);
  }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(c ^ (b | (~d)), a, b, x, s, t);
  }
  function add32(a: number, b: number) {
    return (a + b) & 0xFFFFFFFF;
  }

  function md5blk(s: string) {
    const md5blks: number[] = [];
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }

  function rhex(n: number) {
    const hex_chr = '0123456789ABCDEF';
    let s = '';
    for (let j = 0; j < 4; j++)
      s += hex_chr.charAt((n >> (j * 8 + 4)) & 0x0F) + hex_chr.charAt((n >> (j * 8)) & 0x0F);
    return s;
  }

  function hex(x: number[]) {
    return x.map(rhex).join('');
  }

  let n = str.length;
  let state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= n; i += 64) {
    md5cycle(state, md5blk(str.substring(i - 64, i)));
  }
  str = str.substring(i - 64);
  const tail: number[] = Array(16).fill(0);
  for (i = 0; i < str.length; i++)
    tail[i >> 2] |= str.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    md5cycle(state, tail);
    tail.fill(0);
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return hex(state);
}

function buildSignature(params: Record<string, string>, privateKey: string): string {
  const concat = Object.values(params).join('') + privateKey;
  return md5Hex(concat);
}

async function callMondialRelay(method: string, params: Record<string, string>): Promise<string> {
  const soapParams = Object.entries(params)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <${method} xmlns="http://www.mondialrelay.fr/webservice/">
      ${soapParams}
    </${method}>
  </soap12:Body>
</soap12:Envelope>`;

  const response = await fetch(MR_WSDL, {
    method: "POST",
    headers: {
      "Content-Type": "application/soap+xml; charset=utf-8",
    },
    body: soapBody,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mondial Relay API error ${response.status}: ${text.substring(0, 500)}`);
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

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const enseigne = (Deno.env.get("MONDIAL_RELAY_ENSEIGNE") ?? "").trim();
  const privateKey = (Deno.env.get("MONDIAL_RELAY_PRIVATE_KEY") ?? "").trim();

  if (!enseigne || !privateKey) {
    return new Response(JSON.stringify({ error: "Configuration Mondial Relay manquante" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { action } = body;

    // ── SEARCH RELAY POINTS ──
    if (action === "search_points") {
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

      const xml = await callMondialRelay("WSI4_PointRelais_Recherche", params);
      const stat = extractXmlValue(xml, 'STAT');

      if (stat !== '0') {
        const detail = extractXmlValue(xml, 'Erreur') || extractXmlValue(xml, 'Message') || extractXmlValue(xml, 'Libelle') || '';
        console.error('WSI4_PointRelais_Recherche failed', {
          stat,
          detail,
          enseigneLength: enseigne.length,
          postcode,
          country,
        });
        throw new Error(`Mondial Relay erreur code ${stat}${detail ? `: ${detail}` : ''}`);
      }

      const points = extractRelayPoints(xml);

      return new Response(JSON.stringify({ points }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── CREATE SHIPMENT / LABEL (SOAP v1 - WSI2_CreationEtiquette) ──
    if (action === "create_shipment") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) throw new Error("Non authentifié");

      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const supabase = createClient(supabaseUrl, serviceKey);

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
      const customerNo = order.buyer_id.substring(0, 9);

      // Clean relay ID: keep only digits (6 chars padded)
      const rawRelayId = order.shipping_relay_id || relay_id || "";
      const cleanRelayId = String(rawRelayId).replace(/[^0-9]/g, '').padStart(6, '0').substring(0, 6);
      const relayCountry = String(recipientCountry).trim().toUpperCase() || "FR";

      const deliveryMode = (body?.delivery_mode || "24R").trim().toUpperCase();
      const collectionMode = (body?.collection_mode || "CCC").trim().toUpperCase();

      // Format phone: remove spaces and special chars
      const formatPhone = (phone: string): string => {
        return phone.replace(/[^0-9+]/g, '').substring(0, 10) || "0600000000";
      };

      // Build the params in the EXACT order expected by WSI2_CreationEtiquette
      // The security hash is MD5 of all values concatenated in order + private key
      const params: Record<string, string> = {
        Enseigne: enseigne,
        ModeCol: collectionMode,
        ModeLiv: deliveryMode,
        NDossier: orderNo.substring(0, 15),
        NClient: customerNo.substring(0, 9),
        Expe_Langage: 'FR',
        Expe_Ad1: senderName.substring(0, 32).toUpperCase(),
        Expe_Ad2: '',
        Expe_Ad3: senderAddress.substring(0, 32).toUpperCase(),
        Expe_Ad4: '',
        Expe_Ville: senderCity.substring(0, 26).toUpperCase(),
        Expe_CP: senderPostcode.substring(0, 10),
        Expe_Pays: senderCountry.substring(0, 2).toUpperCase(),
        Expe_Tel1: formatPhone(senderPhone),
        Expe_Tel2: '',
        Expe_Mail: senderEmail.substring(0, 70),
        Dest_Langage: 'FR',
        Dest_Ad1: recipientName.substring(0, 32).toUpperCase(),
        Dest_Ad2: '',
        Dest_Ad3: recipientAddress.substring(0, 32).toUpperCase(),
        Dest_Ad4: '',
        Dest_Ville: recipientCity.substring(0, 26).toUpperCase(),
        Dest_CP: recipientPostcode.substring(0, 10),
        Dest_Pays: relayCountry,
        Dest_Tel1: '',
        Dest_Tel2: '',
        Dest_Mail: '',
        Poids: String(weight),
        Longueur: '',
        Taille: '',
        NbColis: '1',
        CRT_Valeur: '0',
        CRT_Devise: '',
        Exp_Valeur: String(Math.round(order.subtotal * 100)),
        Exp_Devise: 'EUR',
        COL_Rel_Pays: collectionMode === 'REL' ? senderCountry : '',
        COL_Rel: collectionMode === 'REL' ? cleanRelayId : '',
        LIV_Rel_Pays: ['24R', '24L', 'DRI'].includes(deliveryMode) ? relayCountry : '',
        LIV_Rel: ['24R', '24L', 'DRI'].includes(deliveryMode) ? cleanRelayId : '',
        TAss_Valeur: '',
        TAss_Devise: '',
        Montage: '',
        TRDV: '',
        Assurance: '',
        Instructions: '',
      };

      // Compute security hash (all values in order + private key)
      params.Security = buildSignature(params, privateKey);

      console.log("WSI2_CreationEtiquette request:", {
        order_id,
        deliveryMode,
        collectionMode,
        relayId: cleanRelayId,
        relayCountry,
        weight,
      });

      const xml = await callMondialRelay("WSI2_CreationEtiquette", params);
      const stat = extractXmlValue(xml, 'STAT');

      if (stat !== '0') {
        console.error("WSI2_CreationEtiquette failed:", { stat, xml: xml.substring(0, 1000) });
        
        // If relay point rejected, try with nearby relay points
        if ((stat === '82' || stat === '83' || stat === '84') && recipientPostcode) {
          console.log("Relay point rejected, searching for alternatives...");
          
          const searchParams: Record<string, string> = {
            Enseigne: enseigne,
            Pays: relayCountry,
            CP: recipientPostcode,
            Latitude: '',
            Longitude: '',
            Taille: '',
            Poids: '',
            Action: '',
            DelaiEnvoi: '0',
            RayonRecherche: '',
            TypeActivite: '',
            NACE: '',
            NombreResultats: '10',
          };
          searchParams.Security = buildSignature(searchParams, privateKey);

          const searchXml = await callMondialRelay("WSI4_PointRelais_Recherche", searchParams);
          const searchStat = extractXmlValue(searchXml, 'STAT');
          
          if (searchStat === '0') {
            const points = extractRelayPoints(searchXml);
            
            for (const point of points) {
              const altRelayId = String(point.id).replace(/[^0-9]/g, '').padStart(6, '0').substring(0, 6);
              if (altRelayId === cleanRelayId) continue;

              const retryParams = { ...params };
              retryParams.LIV_Rel = altRelayId;
              if (collectionMode === 'REL') retryParams.COL_Rel = altRelayId;
              delete (retryParams as any).Security;
              retryParams.Security = buildSignature(retryParams, privateKey);

              console.log("Retrying with alternative relay:", altRelayId);
              const retryXml = await callMondialRelay("WSI2_CreationEtiquette", retryParams);
              const retryStat = extractXmlValue(retryXml, 'STAT');

              if (retryStat === '0') {
                const expeditionNum = extractXmlValue(retryXml, 'ExpeditionNum');
                if (expeditionNum) {
                  // Get label PDF
                  const labelUrl = await getLabel(enseigne, privateKey, expeditionNum);

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
              }
            }
          }
        }

        // Map common SOAP error codes
        const errorMessages: Record<string, string> = {
          '1': 'Enseigne invalide',
          '2': 'Numéro d\'enseigne vide ou incorrect',
          '3': 'Compte Enseigne non valide ou inactif',
          '8': 'Clé de sécurité incorrecte',
          '20': 'Poids du colis incorrect',
          '24': 'Numéro de Point Relais incorrect',
          '30': 'Mode de collecte incorrect',
          '31': 'Mode de livraison incorrect',
          '60': 'Code postal expéditeur incorrect',
          '61': 'Ville expéditeur incorrecte',
          '62': 'Pays expéditeur incorrect',
          '63': 'Code postal destinataire incorrect',
          '64': 'Ville destinataire incorrecte',
          '65': 'Pays destinataire incorrect',
          '80': 'Code point relais de collecte incorrect',
          '81': 'Point relais de collecte introuvable',
          '82': 'Code point relais de livraison incorrect',
          '83': 'Point relais de livraison introuvable',
          '84': 'Point relais de livraison fermé ou indisponible',
        };

        const errorMsg = errorMessages[stat] || `Erreur Mondial Relay (code ${stat})`;
        throw new Error(errorMsg);
      }

      const expeditionNum = extractXmlValue(xml, 'ExpeditionNum');
      if (!expeditionNum) {
        console.error("No ExpeditionNum in response:", xml.substring(0, 1000));
        throw new Error("Numéro d'expédition non trouvé dans la réponse");
      }

      // Get label PDF using WSI3_GetEtiquettes
      const labelUrl = await getLabel(enseigne, privateKey, expeditionNum);

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

    // ── TRACK SHIPMENT ──
    if (action === "track") {
      const { tracking_number } = body;
      if (!tracking_number) throw new Error("Numéro de suivi requis");

      const params: Record<string, string> = {
        Enseigne: enseigne,
        Expedition: tracking_number,
        Langue: 'FR',
      };
      params.Security = buildSignature(params, privateKey);

      const xml = await callMondialRelay("WSI2_TracingColisDetaille", params);
      const stat = extractXmlValue(xml, 'STAT');

      // Code 95 = shipment not found yet (just created, not scanned)
      if (stat !== '0') {
        if (stat === '95') {
          return new Response(JSON.stringify({
            events: [{ date: new Date().toISOString().split("T")[0], status: "En attente de prise en charge", location: "" }],
            tracking_number,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        throw new Error(`Erreur suivi Mondial Relay (code ${stat})`);
      }

      // Extract tracking events
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

// ── Helper: Get label PDF via WSI3_GetEtiquettes ──
async function getLabel(enseigne: string, privateKey: string, expeditionNum: string): Promise<string | null> {
  try {
    const params: Record<string, string> = {
      Enseigne: enseigne,
      Expeditions: expeditionNum,
      Langue: 'FR',
    };
    params.Security = buildSignature(params, privateKey);

    const xml = await callMondialRelay("WSI3_GetEtiquettes", params);
    const stat = extractXmlValue(xml, 'STAT');

    if (stat !== '0') {
      console.error("WSI3_GetEtiquettes failed:", { stat });
      return null;
    }

    // The response contains a URL_Etiquette field with the label PDF URL
    const labelUrl = extractXmlValue(xml, 'URL_Etiquette');
    if (labelUrl) {
      // Mondial Relay returns relative URLs, prepend the base
      if (labelUrl.startsWith('http')) return labelUrl;
      return `https://www.mondialrelay.com${labelUrl.startsWith('/') ? '' : '/'}${labelUrl}`;
    }

    return null;
  } catch (e) {
    console.error("getLabel error:", e);
    return null;
  }
}
