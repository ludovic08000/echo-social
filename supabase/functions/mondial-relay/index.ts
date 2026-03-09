import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MR_WSDL = "https://api.mondialrelay.com/Web_Services.asmx";
const MR_API_V2_PROD = "https://connect-api.mondialrelay.com/api/shipment";
const MR_API_V2_SANDBOX = "https://connect-api-sandbox.mondialrelay.com/api/shipment";
const MR_API_V2 = Deno.env.get("MONDIAL_RELAY_SANDBOX") === "true" ? MR_API_V2_SANDBOX : MR_API_V2_PROD;

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

    // ── CREATE SHIPMENT / LABEL (API v2 REST) ──
    if (action === "create_shipment") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) throw new Error("Non authentifié");

      // API v2 credentials
      const v2Login = Deno.env.get("MONDIAL_RELAY_V2_LOGIN") ?? "";
      const v2Password = Deno.env.get("MONDIAL_RELAY_V2_PASSWORD") ?? "";
      const v2BrandId = Deno.env.get("MONDIAL_RELAY_V2_BRAND_ID") ?? "";

      if (!v2Login || !v2Password || !v2BrandId) {
        throw new Error("Configuration API v2 Mondial Relay manquante (login/password/brand_id)");
      }

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
      const senderAddress = sender?.address || order.shipping_relay_address || "10 RUE DE TEST";
      const senderCity = sender?.city || order.shipping_relay_city || "PARIS";
      const senderPostcode = sender?.postcode || order.shipping_relay_postcode || "75001";
      const senderCountry = sender?.country || order.shipping_relay_country || "FR";
      const senderPhone = sender?.phone || "0600000000";
      const senderEmail = sender?.email || "support@forsure.app";

      // Build API v2 XML payload (the dual-carrier API expects XML, not JSON)
      const orderNo = order.order_number || `ORD-${order_id.substring(0, 8)}`;
      const customerNo = order.buyer_id.substring(0, 9);
      const senderFirstname = senderName.split(" ")[0] || "Vendeur";
      const senderLastname = senderName.split(" ").slice(1).join(" ") || "ForSure";
      const recipientName = order.shipping_relay_name || "Client";
      const recipientFirstname = recipientName.split(" ")[0] || "Client";
      const recipientLastname = recipientName.split(" ").slice(1).join(" ") || "";

      const escXml = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      const normalizeMode = (mode: unknown, fallback: string) => {
        const cleaned = typeof mode === "string" ? mode.trim().toUpperCase() : "";
        return cleaned || fallback;
      };

      const formatRelayLocation = (raw: unknown) => {
        const cleaned = String(raw ?? "")
          .trim()
          .toUpperCase()
          .replace(/\s+/g, "")
          .replace(/[^A-Z0-9-]/g, "");
        if (!cleaned) return "";
        return cleaned;
      };

      const deliveryMode = normalizeMode(body?.delivery_mode, "24R");
      const collectionMode = normalizeMode(body?.collection_mode, "CCC");
      const rawRelayLocation = order.shipping_relay_id || relay_id || "";
      const relayLocation = formatRelayLocation(rawRelayLocation);

      if (["24R", "24L", "DRI"].includes(deliveryMode) && !relayLocation) {
        throw new Error("Point relais manquant ou invalide pour le mode de livraison sélectionné");
      }

      const relayCountry = String(order.shipping_relay_country || "FR").trim().toUpperCase() || "FR";
      const relayPostcode = String(order.shipping_relay_postcode || "").trim();

      const buildRelayCandidates = (value: string, countryCode: string): string[] => {
        const result: string[] = [];
        const pushUnique = (candidate: string) => {
          if (!candidate) return;
          if (!result.includes(candidate)) result.push(candidate);
        };

        const normalized = formatRelayLocation(value);
        if (!normalized) return result;

        pushUnique(normalized);

        const parts = normalized.split("-");
        const last = parts[parts.length - 1];
        if (last && last !== normalized) {
          pushUnique(last);
        }

        if (!normalized.startsWith(`${countryCode}-`)) {
          pushUnique(`${countryCode}-${last || normalized}`);
        }
        if (!normalized.startsWith(countryCode)) {
          pushUnique(`${countryCode}${last || normalized}`);
        }

        return result;
      };

      const getSoapRelayCandidates = async (postcode: string, countryCode: string): Promise<string[]> => {
        if (!postcode) return [];
        const params: Record<string, string> = {
          Enseigne: enseigne,
          Pays: countryCode,
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
          NombreResultats: '10',
        };
        params.Security = buildSignature(params, privateKey);

        const xml = await callMondialRelay("WSI4_PointRelais_Recherche", params);
        const stat = extractXmlValue(xml, 'STAT');
        if (stat !== '0') return [];

        const points = extractRelayPoints(xml);
        return points
          .map((point) => formatRelayLocation(point?.id))
          .filter(Boolean);
      };

      // Format phone to international format (+33...)
      const formatPhone = (phone: string): string => {
        const cleaned = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
        if (cleaned.startsWith('+')) return cleaned;
        if (cleaned.startsWith('0')) return '+33' + cleaned.substring(1);
        return '+33' + cleaned;
      };

      const buildXmlPayload = (deliveryLocation: string) => {
        const deliveryLocationAttr = deliveryLocation ? ` Location="${escXml(deliveryLocation)}"` : "";
        const collectionLocationAttr = collectionMode === "REL" && deliveryLocation
          ? ` Location="${escXml(deliveryLocation)}"`
          : "";

        return `<?xml version="1.0" encoding="utf-8"?>
<ShipmentCreationRequest xmlns="http://www.example.org/Request">
  <Context>
    <Login>${escXml(v2Login.trim())}</Login>
    <Password>${escXml(v2Password.trim())}</Password>
    <CustomerId>${escXml(v2BrandId.trim())}</CustomerId>
    <Culture>fr-FR</Culture>
    <VersionAPI>1.0</VersionAPI>
  </Context>
  <OutputOptions>
    <OutputFormat>10x15</OutputFormat>
    <OutputType>PdfUrl</OutputType>
  </OutputOptions>
  <ShipmentsList>
    <Shipment>
      <OrderNo>${escXml(orderNo)}</OrderNo>
      <CustomerNo>${escXml(customerNo)}</CustomerNo>
      <ParcelCount>1</ParcelCount>
      <ShipmentValue Currency="EUR" Amount="${Math.round(order.subtotal * 100)}"/>
      <DeliveryMode Mode="${escXml(deliveryMode)}"${deliveryLocationAttr}/>
      <CollectionMode Mode="${escXml(collectionMode)}"${collectionLocationAttr}/>
      <Parcels>
        <Parcel>
          <Content>Commande marketplace</Content>
          <Weight Value="${weight}" Unit="gr"/>
        </Parcel>
      </Parcels>
      <Sender>
        <Address>
          <Title></Title>
          <Firstname>${escXml(senderFirstname)}</Firstname>
          <Lastname>${escXml(senderLastname)}</Lastname>
          <Streetname>${escXml(senderAddress)}</Streetname>
          <CountryCode>${escXml(senderCountry)}</CountryCode>
          <PostCode>${escXml(senderPostcode)}</PostCode>
          <City>${escXml(senderCity)}</City>
          <PhoneNo>${escXml(formatPhone(senderPhone))}</PhoneNo>
          <MobileNo>${escXml(formatPhone(senderPhone))}</MobileNo>
          <Email>${escXml(senderEmail)}</Email>
        </Address>
      </Sender>
      <Recipient>
        <Address>
          <Title></Title>
          <Firstname>${escXml(recipientFirstname)}</Firstname>
          <Lastname>${escXml(recipientLastname)}</Lastname>
          <Streetname>${escXml(order.shipping_relay_address || "")}</Streetname>
          <CountryCode>${escXml(relayCountry)}</CountryCode>
          <PostCode>${escXml(relayPostcode)}</PostCode>
          <City>${escXml(order.shipping_relay_city || "")}</City>
        </Address>
      </Recipient>
    </Shipment>
  </ShipmentsList>
</ShipmentCreationRequest>`;
      };

      const extractBlockingStatus = (rawResponseText: string) => {
        try {
          const parsed = JSON.parse(rawResponseText);
          const statusList = parsed?.statusListField || parsed?.StatusList || [];
          return statusList.find((item: any) => {
            const level = String(item?.levelField || item?.Level || '').toLowerCase();
            return level === 'error';
          }) || null;
        } catch {
          return null;
        }
      };

      let responseText = "";
      let apiResponse: Response | null = null;
      const attemptedRelayLocations = new Set<string>();
      let relayCandidates = buildRelayCandidates(relayLocation, relayCountry);

      if (relayCandidates.length === 0 && ["24R", "24L", "DRI"].includes(deliveryMode)) {
        relayCandidates = [relayLocation];
      }

      for (const candidate of relayCandidates) {
        if (!candidate || attemptedRelayLocations.has(candidate)) continue;
        attemptedRelayLocations.add(candidate);

        const xmlPayload = buildXmlPayload(candidate);
        console.log("API v2 request summary:", {
          order_id,
          deliveryMode,
          collectionMode,
          relayCandidate: candidate,
          relayPostcode,
          relayCountry,
          endpoint: MR_API_V2,
        });

        const currentResponse = await fetch(MR_API_V2, {
          method: "POST",
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Accept": "application/xml, application/json",
          },
          body: xmlPayload,
        });

        const currentText = await currentResponse.text();
        const blockingStatus = extractBlockingStatus(currentText);

        apiResponse = currentResponse;
        responseText = currentText;

        if (!blockingStatus) break;

        const statusCode = String(blockingStatus.codeField || blockingStatus.Code || "");
        if (statusCode === "10025" || statusCode === "10055") {
          continue;
        }

        break;
      }

      const finalBlockingStatus = extractBlockingStatus(responseText);
      if (finalBlockingStatus && (String(finalBlockingStatus.codeField || finalBlockingStatus.Code || "") === "10025" || String(finalBlockingStatus.codeField || finalBlockingStatus.Code || "") === "10055") && relayPostcode) {
        const soapCandidates = await getSoapRelayCandidates(relayPostcode, relayCountry);
        for (const candidate of soapCandidates) {
          if (!candidate || attemptedRelayLocations.has(candidate)) continue;
          attemptedRelayLocations.add(candidate);

          const xmlPayload = buildXmlPayload(candidate);
          console.log("API v2 retry with SOAP relay candidate:", { order_id, relayCandidate: candidate });

          const currentResponse = await fetch(MR_API_V2, {
            method: "POST",
            headers: {
              "Content-Type": "application/xml; charset=utf-8",
              "Accept": "application/xml, application/json",
            },
            body: xmlPayload,
          });

          const currentText = await currentResponse.text();
          apiResponse = currentResponse;
          responseText = currentText;

          const blockingStatus = extractBlockingStatus(currentText);
          if (!blockingStatus) break;
        }
      }

      if (!apiResponse) {
        throw new Error("Impossible de créer l'expédition: aucune réponse API");
      }

      console.log("API v2 response status:", apiResponse.status, "body length:", responseText.length);
      console.log("API v2 response body (full):", responseText);

      // The response can be XML or JSON depending on API version
      let trackingNumber: string | null = null;
      let labelUrl: string | null = null;

      if (responseText.trim().startsWith('<') || responseText.trim().startsWith('<?xml')) {
        // Parse XML response
        // Check for errors first
        const statusCode = extractXmlValue(responseText, 'Code') || extractXmlValue(responseText, 'codeField');
        const statusMessage = extractXmlValue(responseText, 'Message') || extractXmlValue(responseText, 'messageField');
        const statusLevel = extractXmlValue(responseText, 'Level') || extractXmlValue(responseText, 'levelField');

        if (statusLevel === 'Error' || (statusCode && statusCode !== '0')) {
          throw new Error(`Erreur API v2 Mondial Relay (${statusCode}): ${statusMessage}`);
        }

        // Extract shipment number
        trackingNumber = extractXmlValue(responseText, 'ShipmentNumber') 
          || extractXmlValue(responseText, 'ExpeditionNum')
          || extractXmlValue(responseText, 'shipmentNumber');
        
        // Extract label URL  
        labelUrl = extractXmlValue(responseText, 'LabelLink')
          || extractXmlValue(responseText, 'Label')
          || extractXmlValue(responseText, 'labelLink');
      } else {
        // Try JSON parsing
        let result: any;
        try {
          result = JSON.parse(responseText);
        } catch {
          throw new Error(`Réponse API v2 invalide (${apiResponse.status}): ${responseText.substring(0, 500)}`);
        }

        if (!apiResponse.ok) {
          const errMsg = result?.Message || result?.error || result?.title || responseText.substring(0, 300);
          throw new Error(`Erreur API v2 Mondial Relay (${apiResponse.status}): ${errMsg}`);
        }

        // Check for any error in statusListField (JSON envelope)
        const statusList = result?.statusListField || result?.StatusList || [];
        const blockingError = statusList.find((item: any) => {
          const level = String(item?.levelField || item?.Level || '').toLowerCase();
          return level === 'error';
        });
        if (blockingError) {
          throw new Error(`Erreur API v2 (${blockingError.codeField || blockingError.Code || '?' }): ${blockingError.messageField || blockingError.Message || 'Erreur inconnue'}`);
        }

        const shipments = result?.ShipmentsList || result?.shipmentsListField || [];
        if (shipments.length > 0) {
          const first = shipments[0];

          const labelValues = first?.labelListField?.labelField?.rawContentField?.["<LabelValues>k__BackingField"] || [];
          const expeditionValue = labelValues.find((entry: any) =>
            String(entry?.["<Key>k__BackingField"] || "").toLowerCase().includes("numeroexpedition")
          );

          const findDeepValue = (node: any, keyMatcher: (key: string) => boolean): string | null => {
            const seen = new Set<any>();
            const walk = (value: any): string | null => {
              if (!value || typeof value !== "object") return null;
              if (seen.has(value)) return null;
              seen.add(value);

              if (Array.isArray(value)) {
                for (const item of value) {
                  const found = walk(item);
                  if (found) return found;
                }
                return null;
              }

              for (const [k, v] of Object.entries(value)) {
                if (keyMatcher(k) && typeof v === "string" && v.trim()) {
                  return v.trim();
                }
                const found = walk(v);
                if (found) return found;
              }
              return null;
            };
            return walk(node);
          };

          trackingNumber =
            first.ShipmentNumber ||
            first.shipmentNumber ||
            first.ExpeditionNum ||
            first.shipmentNumberField ||
            expeditionValue?.["<Value>k__BackingField"] ||
            findDeepValue(first, (key) => /shipmentnumber|expeditionnum|numeroexpedition/i.test(key)) ||
            null;

          // Extract label URL from labelField.outputField (PdfUrl) or deep search
          const labelField = first?.labelListField?.labelField;
          labelUrl =
            labelField?.outputField ||
            labelField?.output ||
            findDeepValue(first, (key) => /^output(field)?$/i.test(key)) ||
            findDeepValue(first, (key) => /pdfurl|labellink|labelurl/i.test(key)) ||
            null;

          // If still null but we have a shipment number, the sandbox may not generate PDFs
          if (!labelUrl) {
            console.log("No label URL found. labelField keys:", labelField ? Object.keys(labelField) : "N/A");
          }
        }
        if (!labelUrl) {
          labelUrl = result?.LabelLink || result?.labelLink || null;
        }
      }

      if (!trackingNumber) {
        console.error("API v2 full response:", responseText.substring(0, 2000));
        throw new Error("Numéro d'expédition non trouvé dans la réponse API v2");
      }

      // Update order
      await supabase
        .from("orders")
        .update({
          tracking_number: trackingNumber,
          shipping_label_url: labelUrl,
          shipping_weight_grams: weight,
          shipped_at: new Date().toISOString(),
          status: "shipped",
        })
        .eq("id", order_id);

      return new Response(JSON.stringify({ tracking_number: trackingNumber, label_url: labelUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── TRACK SHIPMENT ──
    if (action === "track") {
      const { tracking_number } = body;
      if (!tracking_number) throw new Error("Numéro de suivi requis");

      // Sandbox tracking numbers can't be tracked
      if (tracking_number === "SANDBOX MODE" || tracking_number.startsWith("0003")) {
        return new Response(JSON.stringify({
          events: [{ date: new Date().toISOString().split("T")[0], status: "Expédition enregistrée (mode sandbox)", location: "" }],
          tracking_number,
          sandbox: true,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

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
