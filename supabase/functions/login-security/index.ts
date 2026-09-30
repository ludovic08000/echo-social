import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.117.0';
import { getCorsHeaders } from '../_shared/cors.ts';
import { assessLoginRisk, loginDecisionMutation } from './risk.ts';

type JsonObject = Record<string, unknown>;
type Decision = 'approve' | 'deny';
type ChallengeIntent = 'assess' | Decision;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const encoder = new TextEncoder();
const SITE_URL = (Deno.env.get('SITE_URL') || 'https://forsure.fans').replace(/\/$/, '');

function json(req: Request, status: number, body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(req),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function stringField(input: JsonObject, field: string, max = 512): string {
  const value = input[field];
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return encoder.encode(normalized).byteLength <= max ? normalized : '';
}

function decodeJwtPayload(token: string): JsonObject | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return JSON.parse(decoded) as JsonObject;
  } catch {
    return null;
  }
}

function decodeBase64(value: string, expectedLength: number): Uint8Array<ArrayBuffer> {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
    throw new Error('BASE64_INVALID');
  }
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength !== expectedLength) throw new Error('BASE64_LENGTH_INVALID');
  return bytes;
}

async function verifyEd25519(publicKey: string, signature: string, payload: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      decodeBase64(publicKey, 32),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      decodeBase64(signature, 64),
      encoder.encode(payload),
    );
  } catch {
    return false;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

function cleanHeader(value: string | null, max: number): string | null {
  if (!value) return null;
  const normalized = Array.from(value.trim())
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
  return normalized && normalized.length <= max ? normalized : null;
}

function requestContext(req: Request) {
  // Supabase's gateway records these Cloudflare-provided headers as the
  // requester's network context. Never fall back to client-selectable
  // x-country/x-vercel headers: a cloned client could spoof them to imitate
  // the user's habitual country.
  const ip = cleanHeader(req.headers.get('cf-connecting-ip'), 64);
  const country = cleanHeader(req.headers.get('cf-ipcountry'), 2)?.toUpperCase() || null;
  const region = null;
  const city = null;
  const userAgent = cleanHeader(req.headers.get('user-agent'), 1024) || 'unknown';
  return { ip, country: country && /^[A-Z]{2}$/.test(country) ? country : null, region, city, userAgent };
}

function summarizeUserAgent(userAgent: string): string {
  const os = /Android/i.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/i.test(userAgent) ? 'iOS'
    : /Windows/i.test(userAgent) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(userAgent) ? 'macOS'
    : /Linux/i.test(userAgent) ? 'Linux'
    : 'Appareil inconnu';
  const browser = /Edg/i.test(userAgent) ? 'Edge'
    : /Firefox|FxiOS/i.test(userAgent) ? 'Firefox'
    : /Chrome|CriOS/i.test(userAgent) ? 'Chrome'
    : /Safari/i.test(userAgent) ? 'Safari'
    : 'Navigateur';
  return `${browser} · ${os}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] || character);
}

async function readBoundedBody(req: Request, maxBytes: number): Promise<string | null> {
  const declaredLength = Number(req.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  try {
    const raw = await req.text();
    return encoder.encode(raw).byteLength <= maxBytes ? raw : null;
  } catch {
    return null;
  }
}

async function parseBody(req: Request): Promise<JsonObject | null> {
  const raw = await readBoundedBody(req, 16_384);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : null;
  } catch {
    return null;
  }
}

function sessionView(row: JsonObject | null): JsonObject {
  if (!row) return { status: 'unassessed' };
  return {
    sessionId: row.session_id,
    status: row.status,
    riskLevel: row.risk_level,
    reasons: row.risk_reasons,
    knownDevice: row.known_device,
    deviceId: row.device_id,
    countryCode: row.country_code,
    region: row.region,
    city: row.city,
    device: row.user_agent_summary,
    createdAt: row.created_at,
    emailSentAt: row.email_sent_at,
    approvedVia: row.approved_via,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: getCorsHeaders(req) });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json(req, 503, { ok: false, code: 'LOGIN_SECURITY_UNAVAILABLE' });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const recordEvent = async (
    userId: string,
    sessionId: string | null,
    eventType: string,
    outcome: 'info' | 'success' | 'failure',
    detail: JsonObject = {},
  ) => {
    await admin.from('login_security_events').insert({
      user_id: userId,
      session_id: sessionId,
      event_type: eventType,
      outcome,
      detail,
    });
  };

  const revokeSession = async (userId: string, sessionId: string) => {
    await admin.rpc('revoke_login_security_auth_session', {
      p_user_id: userId,
      p_session_id: sessionId,
    });
  };

  const decide = async (
    userId: string,
    targetSessionId: string,
    decision: Decision,
    via: string,
  ): Promise<boolean> => {
    const now = new Date().toISOString();
    const mutation = loginDecisionMutation({
      decision,
      via,
      nowIso: now,
      approvedExpiresAtIso: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    });
    const { data, error } = await admin
      .from('login_security_sessions')
      .update(mutation.values)
      .eq('user_id', userId)
      .eq('session_id', targetSessionId)
      .eq('status', 'pending')
      .gt('expires_at', now)
      .select('session_id')
      .maybeSingle();
    if (error || !data) return false;
    if (mutation.revokeAuthSession) await revokeSession(userId, targetSessionId);
    await recordEvent(userId, targetSessionId, 'login_decision', 'success', { decision, via });
    return true;
  };

  const queueApprovalEmail = async (args: {
    userId: string;
    sessionId: string;
    email: string;
    country: string | null;
    region: string | null;
    city: string | null;
    device: string;
  }): Promise<boolean> => {
    const normalizedEmail = args.email.trim().toLowerCase();
    const { data: existingUnsubscribeToken, error: unsubscribeLookupError } = await admin
      .from('email_unsubscribe_tokens')
      .select('token')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (unsubscribeLookupError) return false;

    let unsubscribeToken = existingUnsubscribeToken?.token as string | undefined;
    if (!unsubscribeToken) {
      const { error: unsubscribeInsertError } = await admin
        .from('email_unsubscribe_tokens')
        .upsert(
          { token: randomToken(), email: normalizedEmail },
          { onConflict: 'email', ignoreDuplicates: true },
        );
      if (unsubscribeInsertError) return false;

      const { data: storedUnsubscribeToken, error: unsubscribeReadbackError } = await admin
        .from('email_unsubscribe_tokens')
        .select('token')
        .eq('email', normalizedEmail)
        .maybeSingle();
      if (unsubscribeReadbackError || !storedUnsubscribeToken?.token) return false;
      unsubscribeToken = storedUnsubscribeToken.token;
    }

    const token = randomToken();
    const tokenHash = await sha256(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    await admin
      .from('login_security_email_tokens')
      .update({ expires_at: now.toISOString() })
      .eq('user_id', args.userId)
      .eq('target_session_id', args.sessionId)
      .is('consumed_at', null);
    const { error: tokenError } = await admin.from('login_security_email_tokens').insert({
      user_id: args.userId,
      target_session_id: args.sessionId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });
    if (tokenError) return false;

    // A resend must renew the pending session for the same duration as the new
    // token. Otherwise a fresh 15-minute e-mail can point at a session that is
    // only seconds away from expiry, making a valid click impossible to apply.
    const { data: renewedSession, error: renewError } = await admin
      .from('login_security_sessions')
      .update({ expires_at: expiresAt, updated_at: now.toISOString() })
      .eq('user_id', args.userId)
      .eq('session_id', args.sessionId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (renewError || !renewedSession) return false;

    const endpoint = `${supabaseUrl}/functions/v1/login-security`;
    // Mail providers such as Yahoo may rewrite links and discard fragments.
    // Keep the first hop read-only and use query parameters only to reach this
    // function. The GET below immediately moves the secret into a ForSure URL
    // fragment, so previews cannot apply a decision and the token is not sent
    // to the application host.
    const approveUrl = `${endpoint}?token=${encodeURIComponent(token)}&decision=approve`;
    const denyUrl = `${endpoint}?token=${encodeURIComponent(token)}&decision=deny`;
    const location = [args.city, args.region, args.country].filter(Boolean).join(', ') || 'Localisation indisponible';
    const safeDevice = escapeHtml(args.device);
    const safeLocation = escapeHtml(location);
    const html = `<!doctype html><html lang="fr"><body style="font-family:Arial,sans-serif;background:#f5f7fb;color:#172033;padding:24px"><div style="max-width:600px;margin:auto;background:#fff;border-radius:18px;padding:28px"><h1 style="margin-top:0">Nouvelle connexion ForSure</h1><p>Une connexion demande l’accès à votre compte.</p><p><strong>Appareil :</strong> ${safeDevice}<br><strong>Zone :</strong> ${safeLocation}<br><strong>Heure :</strong> ${escapeHtml(now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }))}</p><p style="margin:28px 0"><a href="${escapeHtml(approveUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">C’était bien moi</a></p><p style="margin:20px 0"><a href="${escapeHtml(denyUrl)}" style="color:#b91c1c;font-weight:bold">Ce n’était pas moi — bloquer cette connexion</a></p><p style="color:#667085;font-size:13px">Le bouton choisi applique directement votre décision. Chaque lien est à usage unique et expire dans 15 minutes. ForSure ne vous demandera jamais votre mot de passe par e-mail.</p></div></body></html>`;
    const text = `Nouvelle connexion ForSure\n\nAppareil : ${args.device}\nZone : ${location}\n\nC’était bien moi : ${approveUrl}\n\nCe n’était pas moi — bloquer cette connexion : ${denyUrl}\n\nChaque lien applique directement votre décision. Lien à usage unique, valable 15 minutes.`;
    const messageId = `login-security:${args.sessionId}:${tokenHash.slice(0, 16)}`;

    await admin.from('email_send_log').insert({
      message_id: messageId,
      template_name: 'login_security_approval',
      recipient_email: args.email,
      status: 'pending',
      metadata: { user_id: args.userId, session_id: args.sessionId },
    });
    const { error: enqueueError } = await admin.rpc('enqueue_email', {
      queue_name: 'auth_emails',
      payload: {
        message_id: messageId,
        to: args.email,
        from: 'ForSure <noreply@notify.forsure.fans>',
        sender_domain: 'notify.forsure.fans',
        subject: 'Confirmez votre nouvelle connexion ForSure',
        html,
        text,
        // Custom approval messages are app-generated transactional e-mails.
        // Lovable reserves purpose=authentication for Auth Hook deliveries
        // carrying a platform-issued run_id.
        purpose: 'transactional',
        label: 'login_security_approval',
        idempotency_key: messageId,
        // Lovable's app-email transport requires this metadata even for
        // mandatory security notices. The message itself contains no opt-out.
        unsubscribe_token: unsubscribeToken,
        queued_at: now.toISOString(),
      },
    });
    if (enqueueError) {
      await admin.from('email_send_log').insert({
        message_id: `${messageId}:enqueue-failure`,
        template_name: 'login_security_approval',
        recipient_email: args.email,
        status: 'failed',
        error_message: 'Failed to enqueue login approval email',
      });
      return false;
    }
    await admin
      .from('login_security_sessions')
      .update({ email_sent_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('user_id', args.userId)
      .eq('session_id', args.sessionId);
    return true;
  };

  // Email links intentionally work without a bearer token. This GET is always
  // read-only: it only transfers a syntactically valid token and decision into
  // a fragment on the trusted ForSure origin. The web application then performs
  // the explicit form POST. This survives provider link rewriting while keeping
  // ordinary HTTP previews unable to approve or deny a login.
  if (req.method === 'GET') {
    const requestUrl = new URL(req.url);
    const token = requestUrl.searchParams.get('token') || '';
    const decision = requestUrl.searchParams.get('decision') as Decision | null;
    if (!/^[a-f0-9]{64}$/.test(token) || !decision || !['approve', 'deny'].includes(decision)) {
      return redirect(`${SITE_URL}/login?loginSecurity=invalid`);
    }

    const bridgeUrl = new URL('/feed', `${SITE_URL}/`);
    bridgeUrl.hash = new URLSearchParams({
      loginSecurityToken: token,
      loginSecurityDecision: decision,
    }).toString();
    return redirect(bridgeUrl.toString());
  }

  const contentType = req.headers.get('content-type') || '';
  if (req.method === 'POST' && contentType.includes('application/x-www-form-urlencoded')) {
    const rawForm = await readBoundedBody(req, 4_096);
    if (rawForm === null) return redirect(`${SITE_URL}/login?loginSecurity=invalid`);
    const form = new URLSearchParams(rawForm);
    const action = form.get('action');
    const token = form.get('token') || '';
    const decision = form.get('decision') as Decision | null;
    if (action !== 'email_decision' || !/^[a-f0-9]{64}$/.test(token)
      || !decision || !['approve', 'deny'].includes(decision)) {
      return redirect(`${SITE_URL}/login?loginSecurity=invalid`);
    }
    const tokenHash = await sha256(token);
    const { data: emailToken, error: emailTokenError } = await admin
      .from('login_security_email_tokens')
      .select('id,user_id,target_session_id,expires_at,consumed_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (emailTokenError || !emailToken || emailToken.consumed_at
      || new Date(emailToken.expires_at).getTime() <= Date.now()) {
      return redirect(`${SITE_URL}/login?loginSecurity=expired`);
    }
    const completed = await decide(
      emailToken.user_id,
      emailToken.target_session_id,
      decision,
      'email',
    );
    if (!completed) return redirect(`${SITE_URL}/login?loginSecurity=expired`);

    // The pending session row is the concurrency gate. Mark the token consumed
    // after the decision so a transient token update cannot burn a still-pending
    // approval. Replays remain harmless because decide() only mutates pending rows.
    const now = new Date().toISOString();
    const { data: consumed, error: consumeError } = await admin
      .from('login_security_email_tokens')
      .update({ consumed_at: now, consumed_decision: decision })
      .eq('id', emailToken.id)
      .is('consumed_at', null)
      .select('id')
      .maybeSingle();
    if (consumeError || !consumed) {
      await recordEvent(
        emailToken.user_id,
        emailToken.target_session_id,
        'email_token_consume',
        'failure',
        { reason: 'TOKEN_MARK_FAILED', decision },
      );
    }

    const next = decision === 'approve' ? '&next=%2Ffeed' : '';
    return redirect(`${SITE_URL}/login?loginSecurity=${decision === 'approve' ? 'approved' : 'denied'}${next}`);
  }

  if (req.method !== 'POST') return json(req, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });

  const authorization = req.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) {
    return json(req, 401, { ok: false, code: 'NOT_AUTHENTICATED' });
  }
  const accessToken = authorization.slice('Bearer '.length).trim();
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser(accessToken);
  const user = userData.user;
  const claims = decodeJwtPayload(accessToken);
  const sessionId = typeof claims?.session_id === 'string' && UUID_RE.test(claims.session_id)
    ? claims.session_id
    : '';
  if (userError || !user?.id || !user.email || !sessionId) {
    return json(req, 401, { ok: false, code: 'NOT_AUTHENTICATED' });
  }

  const body = await parseBody(req);
  if (!body) return json(req, 400, { ok: false, code: 'INVALID_JSON' });
  const action = stringField(body, 'action', 40);

  const loadCurrentSession = async () => {
    const { data } = await admin
      .from('login_security_sessions')
      .select('*')
      .eq('user_id', user.id)
      .eq('session_id', sessionId)
      .maybeSingle();
    if ((data?.status === 'pending' || data?.status === 'approved')
      && new Date(data.expires_at).getTime() <= Date.now()) {
      const now = new Date().toISOString();
      const { data: expired } = await admin
        .from('login_security_sessions')
        .update({ status: 'expired', updated_at: now })
        .eq('user_id', user.id)
        .eq('session_id', sessionId)
        .in('status', ['pending', 'approved'])
        .select('*')
        .maybeSingle();
      return (expired || data) as JsonObject;
    }
    return data as JsonObject | null;
  };

  const consumeTrustedDeviceProof = async (intent: ChallengeIntent, targetSessionId?: string) => {
    const challengeId = stringField(body, 'challengeId', 64);
    const deviceId = stringField(body, 'deviceId', 128);
    const signature = stringField(body, 'signature', 256);
    if (!UUID_RE.test(challengeId) || !DEVICE_ID_RE.test(deviceId) || !signature) return null;

    const { data: challenge } = await admin
      .from('login_security_challenges')
      .select('*')
      .eq('id', challengeId)
      .eq('user_id', user.id)
      .eq('session_id', sessionId)
      .eq('intent', intent)
      .is('consumed_at', null)
      .maybeSingle();
    if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now()) return null;
    if (challenge.device_id !== deviceId || (challenge.target_session_id || null) !== (targetSessionId || null)) {
      return null;
    }

    const { data: device } = await admin
      .from('user_devices')
      .select('device_id,device_signing_key,approval_status,is_active,revoked_at,crypto_invalid_at')
      .eq('user_id', user.id)
      .eq('device_id', deviceId)
      .eq('approval_status', 'approved')
      .eq('is_active', true)
      .is('revoked_at', null)
      .is('crypto_invalid_at', null)
      .maybeSingle();
    if (!device?.device_signing_key) return null;
    const verified = await verifyEd25519(device.device_signing_key, signature, challenge.payload);
    await admin
      .from('login_security_challenges')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', challengeId)
      .is('consumed_at', null);
    return verified ? { deviceId, signingKey: device.device_signing_key } : null;
  };

  if (action === 'challenge') {
    const intent = stringField(body, 'intent', 16) as ChallengeIntent;
    const deviceId = stringField(body, 'deviceId', 128);
    const targetSessionId = stringField(body, 'targetSessionId', 64) || null;
    if (!['assess', 'approve', 'deny'].includes(intent) || !DEVICE_ID_RE.test(deviceId)) {
      return json(req, 400, { ok: false, code: 'CHALLENGE_INPUT_INVALID' });
    }
    if (intent !== 'assess' && (!targetSessionId || !UUID_RE.test(targetSessionId))) {
      return json(req, 400, { ok: false, code: 'TARGET_SESSION_INVALID' });
    }
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const { count: recentChallenges } = await admin
      .from('login_security_challenges')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('session_id', sessionId)
      .gte('created_at', fiveMinutesAgo);
    if ((recentChallenges || 0) >= 20) {
      return json(req, 429, { ok: false, code: 'CHALLENGE_RATE_LIMITED', retryAfter: 300 });
    }
    const challengeId = crypto.randomUUID();
    const issuedAt = new Date().toISOString();
    const payload = JSON.stringify({
      protocol: 'forsure-login-security',
      version: 1,
      userId: user.id,
      sessionId,
      deviceId,
      challengeId,
      intent,
      targetSessionId,
      nonce: randomToken(),
      issuedAt,
    });
    const { error } = await admin.from('login_security_challenges').insert({
      id: challengeId,
      user_id: user.id,
      session_id: sessionId,
      intent,
      target_session_id: targetSessionId,
      device_id: deviceId,
      payload,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    if (error) return json(req, 503, { ok: false, code: 'CHALLENGE_UNAVAILABLE' });
    return json(req, 200, { ok: true, challengeId, payload, expiresIn: 300 });
  }

  if (action === 'status') {
    return json(req, 200, { ok: true, session: sessionView(await loadCurrentSession()) });
  }

  if (action === 'assess') {
    const existing = await loadCurrentSession();
    if (existing?.status === 'approved' && new Date(String(existing.expires_at)).getTime() > Date.now()) {
      await admin.from('login_security_sessions').update({
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('user_id', user.id).eq('session_id', sessionId);
      return json(req, 200, { ok: true, session: sessionView(existing) });
    }
    if (existing?.status === 'denied') {
      return json(req, 403, { ok: false, code: 'LOGIN_DENIED', session: sessionView(existing) });
    }
    // Assessment is idempotent. A pending session with a queued e-mail must
    // not generate another token/message merely because the client retries or
    // reloads. Explicit resends use the separately rate-limited action below.
    if (existing?.status === 'pending'
      && existing.email_sent_at
      && new Date(String(existing.expires_at)).getTime() > Date.now()) {
      await admin.from('login_security_sessions').update({
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('user_id', user.id).eq('session_id', sessionId);
      return json(req, 200, { ok: true, session: sessionView(existing) });
    }

    const proof = await consumeTrustedDeviceProof('assess');
    const context = requestContext(req);
    const timezone = stringField(body, 'timezone', 80) || null;
    const language = stringField(body, 'language', 32) || null;
    const { data: previous } = await admin
      .from('login_security_sessions')
      .select('country_code,approved_at')
      .eq('user_id', user.id)
      .eq('status', 'approved')
      .neq('session_id', sessionId)
      .not('country_code', 'is', null)
      .order('approved_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const risk = assessLoginRisk({
      trustedDeviceProof: Boolean(proof),
      previousCountry: previous?.country_code || null,
      currentCountry: context.country,
    });
    const { status, riskLevel, reasons, countryChanged } = risk;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (status === 'approved'
      ? 30 * 24 * 60 * 60_000
      : 15 * 60_000)).toISOString();
    const ipHash = context.ip ? await hmacSha256(serviceRoleKey, context.ip) : null;
    const userAgentHash = await sha256(context.userAgent);
    const row = {
      session_id: sessionId,
      user_id: user.id,
      device_id: proof?.deviceId || null,
      status,
      risk_level: riskLevel,
      risk_reasons: reasons,
      known_device: Boolean(proof),
      country_code: context.country,
      region: context.region,
      city: context.city,
      ip_hash: ipHash,
      user_agent_hash: userAgentHash,
      user_agent_summary: summarizeUserAgent(context.userAgent),
      timezone,
      language,
      device_proof_verified_at: proof ? now : null,
      approved_at: status === 'approved' ? now : null,
      approved_via: status === 'approved' ? 'trusted_device' : null,
      last_seen_at: now,
      updated_at: now,
      expires_at: expiresAt,
    };
    const { data: saved, error: saveError } = await admin
      .from('login_security_sessions')
      .upsert(row, { onConflict: 'session_id' })
      .select('*')
      .single();
    if (saveError) return json(req, 503, { ok: false, code: 'ASSESSMENT_PERSIST_FAILED' });
    await recordEvent(user.id, sessionId, 'login_assessment', 'success', {
      status,
      risk_level: riskLevel,
      reasons,
      known_device: Boolean(proof),
      country_changed: countryChanged,
    });
    if (status === 'pending') {
      const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
      const { count: recentEmails } = await admin
        .from('login_security_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .not('email_sent_at', 'is', null)
        .gte('email_sent_at', oneHourAgo);
      if ((recentEmails || 0) >= 5) {
        await recordEvent(user.id, sessionId, 'approval_email', 'failure', {
          reason: 'USER_HOURLY_RATE_LIMIT',
        });
        return json(req, 429, {
          ok: false,
          code: 'APPROVAL_EMAIL_RATE_LIMITED',
          session: sessionView(saved),
          retryAfter: 3600,
        });
      }
      const queued = await queueApprovalEmail({
        userId: user.id,
        sessionId,
        email: user.email,
        country: context.country,
        region: context.region,
        city: context.city,
        device: summarizeUserAgent(context.userAgent),
      });
      if (!queued) {
        await recordEvent(user.id, sessionId, 'approval_email', 'failure', { reason: 'QUEUE_FAILED' });
        return json(req, 503, { ok: false, code: 'APPROVAL_EMAIL_FAILED', session: sessionView(saved) });
      }
      await recordEvent(user.id, sessionId, 'approval_email', 'success');
    }
    return json(req, 200, { ok: true, session: sessionView(saved) });
  }

  if (action === 'resend') {
    const current = await loadCurrentSession();
    if (!current || current.status !== 'pending'
      || new Date(String(current.expires_at)).getTime() <= Date.now()) {
      return json(req, 409, { ok: false, code: 'LOGIN_NOT_PENDING' });
    }
    const lastSent = current.email_sent_at ? new Date(String(current.email_sent_at)).getTime() : 0;
    if (lastSent && Date.now() - lastSent < 5 * 60_000) {
      return json(req, 429, { ok: false, code: 'EMAIL_RESEND_RATE_LIMITED', retryAfter: 300 });
    }
    const queued = await queueApprovalEmail({
      userId: user.id,
      sessionId,
      email: user.email,
      country: typeof current.country_code === 'string' ? current.country_code : null,
      region: typeof current.region === 'string' ? current.region : null,
      city: typeof current.city === 'string' ? current.city : null,
      device: typeof current.user_agent_summary === 'string' ? current.user_agent_summary : 'Appareil inconnu',
    });
    return queued
      ? json(req, 200, { ok: true, code: 'APPROVAL_EMAIL_QUEUED' })
      : json(req, 503, { ok: false, code: 'APPROVAL_EMAIL_FAILED' });
  }

  if (action === 'list_pending') {
    const current = await loadCurrentSession();
    if (!current || current.status !== 'approved') {
      return json(req, 403, { ok: false, code: 'TRUSTED_SESSION_REQUIRED' });
    }
    const { data } = await admin
      .from('login_security_sessions')
      .select('session_id,status,risk_level,risk_reasons,country_code,region,city,user_agent_summary,created_at,email_sent_at')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .neq('session_id', sessionId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(10);
    return json(req, 200, { ok: true, sessions: (data || []).map((row) => sessionView(row as JsonObject)) });
  }

  if (action === 'decide_pending') {
    const decision = stringField(body, 'decision', 16) as Decision;
    const targetSessionId = stringField(body, 'targetSessionId', 64);
    if (!['approve', 'deny'].includes(decision) || !UUID_RE.test(targetSessionId) || targetSessionId === sessionId) {
      return json(req, 400, { ok: false, code: 'DECISION_INPUT_INVALID' });
    }
    const current = await loadCurrentSession();
    if (!current || current.status !== 'approved') {
      return json(req, 403, { ok: false, code: 'TRUSTED_SESSION_REQUIRED' });
    }
    const proof = await consumeTrustedDeviceProof(decision, targetSessionId);
    if (!proof || current.device_id !== proof.deviceId) {
      return json(req, 403, { ok: false, code: 'TRUSTED_DEVICE_PROOF_REQUIRED' });
    }
    const completed = await decide(user.id, targetSessionId, decision, 'trusted_device');
    return completed
      ? json(req, 200, { ok: true, code: decision === 'approve' ? 'LOGIN_APPROVED' : 'LOGIN_DENIED' })
      : json(req, 409, { ok: false, code: 'LOGIN_DECISION_NOT_APPLIED' });
  }

  return json(req, 400, { ok: false, code: 'UNKNOWN_ACTION' });
});
