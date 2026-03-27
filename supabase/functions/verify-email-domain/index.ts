import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email } = await req.json();

    if (!email || typeof email !== 'string') {
      return new Response(JSON.stringify({ valid: false, reason: 'missing_email' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Basic format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({ valid: false, reason: 'invalid_format' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const domain = email.split('@')[1].toLowerCase();

    // Block disposable/temporary email domains
    const disposableDomains = [
      'yopmail.com', 'tempmail.com', 'guerrillamail.com', 'mailinator.com',
      'throwaway.email', 'temp-mail.org', 'fakeinbox.com', 'sharklasers.com',
      'guerrillamailblock.com', 'grr.la', 'dispostable.com', 'trashmail.com',
      'maildrop.cc', 'getairmail.com', 'getnada.com', 'emailondeck.com',
      'tempail.com', 'mohmal.com', '10minutemail.com', 'minuteinbox.com',
    ];

    if (disposableDomains.includes(domain)) {
      return new Response(JSON.stringify({ valid: false, reason: 'disposable_email' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // DNS MX record check via public DNS-over-HTTPS (Google)
    const dnsResp = await fetch(`https://dns.google/resolve?name=${domain}&type=MX`, {
      headers: { 'Accept': 'application/dns-json' },
    });

    if (!dnsResp.ok) {
      // DNS check failed, be permissive
      return new Response(JSON.stringify({ valid: true, reason: 'dns_check_failed' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const dnsData = await dnsResp.json();

    // Status 0 = NOERROR, check for MX records (type 15) or at least A records
    const hasMX = dnsData.Answer?.some((r: any) => r.type === 15);

    if (hasMX) {
      return new Response(JSON.stringify({ valid: true, reason: 'mx_found' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // No MX, check if domain has A record (some domains accept mail without MX)
    const aResp = await fetch(`https://dns.google/resolve?name=${domain}&type=A`, {
      headers: { 'Accept': 'application/dns-json' },
    });
    const aData = await aResp.json();
    const hasA = aData.Answer?.some((r: any) => r.type === 1);

    if (hasA) {
      return new Response(JSON.stringify({ valid: true, reason: 'a_record_only' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // No MX and no A record — domain cannot receive email
    return new Response(JSON.stringify({ valid: false, reason: 'no_mx_record' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Email verification error:', error);
    // Be permissive on error
    return new Response(JSON.stringify({ valid: true, reason: 'check_error' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
