import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkRateLimit as checkRateLimitDB } from '../_shared/rate-limit.ts';

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const RATE_LIMIT = 12;
const RATE_WINDOW_SECONDS = 60;
const ALLOWED_ORIGINS = [
  'https://calm-connect-05.lovable.app',
  'https://forsure.fans',
  'https://www.forsure.fans',
];

type BackupType = 'account' | 'recovery';

interface EncryptedBackupEnvelope {
  encrypted_blob: string;
  iv: string;
  salt: string;
  wrapped_master_key: string;
  master_key_iv: string;
  version: number;
  backup_type: BackupType;
  created_at: string;
}

interface R2Config {
  endpoint: string;
  host: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin)
    || /^https:\/\/[a-z0-9-]+--[a-f0-9-]+\.lovable\.app$/.test(origin)
    || /^https:\/\/[a-z0-9-]+\.lovableproject\.com$/.test(origin);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validateEnvelope(value: unknown): EncryptedBackupEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (!isNonEmptyString(row.encrypted_blob, MAX_BACKUP_BYTES * 2)) return null;
  if (!isNonEmptyString(row.iv, 256)) return null;
  if (!isNonEmptyString(row.salt, 512)) return null;
  if (!isNonEmptyString(row.wrapped_master_key, 4096)) return null;
  if (!isNonEmptyString(row.master_key_iv, 256)) return null;
  if (!Number.isInteger(row.version) || Number(row.version) < 1 || Number(row.version) > 100) return null;
  if (row.backup_type !== 'account' && row.backup_type !== 'recovery') return null;
  if (typeof row.created_at !== 'string' || Number.isNaN(Date.parse(row.created_at))) return null;

  return {
    encrypted_blob: row.encrypted_blob,
    iv: row.iv,
    salt: row.salt,
    wrapped_master_key: row.wrapped_master_key,
    master_key_iv: row.master_key_iv,
    version: Number(row.version),
    backup_type: row.backup_type,
    created_at: row.created_at,
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', source)));
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const raw = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)),
  );
}

async function hmacText(key: string, message: string): Promise<Uint8Array> {
  return hmac(new TextEncoder().encode(key), message);
}

async function opaqueNamespace(userId: string, secret: string): Promise<string> {
  return toHex(await hmacText(secret, `forsure-r2-backup-v1:${userId}`));
}

function loadR2Config(): R2Config {
  const accountId = Deno.env.get('R2_ACCOUNT_ID')?.trim() ?? '';
  let accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID')?.trim() ?? '';
  let secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY')?.trim() ?? '';
  const bucket = (
    Deno.env.get('R2_BACKUP_BUCKET_NAME')
    || Deno.env.get('R2_BUCKET_NAME')
    || ''
  ).trim();
  const region = Deno.env.get('R2_REGION')?.trim() ?? '';

  if (accessKeyId.length === 64 && secretAccessKey.length === 32) {
    [accessKeyId, secretAccessKey] = [secretAccessKey, accessKeyId];
  }
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('R2 backup configuration incomplete');
  }

  const regionPrefix = region ? `${region}.` : '';
  const host = `${accountId}.${regionPrefix}r2.cloudflarestorage.com`;
  return {
    endpoint: `https://${host}`,
    host,
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

function awsDate(now = new Date()): { full: string; short: string } {
  const full = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return { full, short: full.slice(0, 8) };
}

async function awsAuthorization(args: {
  method: 'GET' | 'PUT' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  payloadHash: string;
  date: string;
  shortDate: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Promise<string> {
  const normalized = Object.fromEntries(
    Object.entries(args.headers).map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, ' ')]),
  );
  const keys = Object.keys(normalized).sort();
  const signedHeaders = keys.join(';');
  const canonicalHeaders = keys.map((key) => `${key}:${normalized[key]}\n`).join('');
  const canonicalRequest = [
    args.method,
    args.path,
    '',
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join('\n');
  const scope = `${args.shortDate}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    args.date,
    scope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join('\n');

  const kDate = await hmacText(`AWS4${args.secretAccessKey}`, args.shortDate);
  const kRegion = await hmac(kDate, 'auto');
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function r2Request(
  config: R2Config,
  method: 'GET' | 'PUT' | 'DELETE',
  objectKey: string,
  body?: Uint8Array,
): Promise<Response> {
  const payload = body ?? new Uint8Array(0);
  const payloadHash = await sha256Hex(payload);
  const date = awsDate();
  const path = `/${config.bucket}/${objectKey}`;
  const headers: Record<string, string> = {
    host: config.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': date.full,
  };
  if (method === 'PUT') {
    headers['content-type'] = 'application/octet-stream';
    headers['cache-control'] = 'private, no-store';
  }

  const authorization = await awsAuthorization({
    method,
    path,
    headers,
    payloadHash,
    date: date.full,
    shortDate: date.short,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });

  return fetch(`${config.endpoint}${path}`, {
    method,
    headers: { ...headers, Authorization: authorization },
    body: method === 'PUT' ? payload : undefined,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  try {
    const authorization = req.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      return json(req, { error: 'Not authenticated' }, 401);
    }

    const token = authorization.slice(7);
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authorization } } },
    );
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    const userId = claimsData?.claims?.sub as string | undefined;
    if (claimsError || !userId) return json(req, { error: 'Not authenticated' }, 401);

    const rateLimited = await checkRateLimitDB(
      `e2ee-backup-vault:${userId}`,
      RATE_LIMIT,
      RATE_WINDOW_SECONDS,
      corsHeaders(req),
    );
    if (rateLimited) return rateLimited;

    const namespaceSecret = (
      Deno.env.get('R2_BACKUP_NAMESPACE_SECRET')
      || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
      || ''
    ).trim();
    if (namespaceSecret.length < 32) {
      return json(req, { error: 'Backup vault unavailable' }, 503);
    }

    const input = await req.json().catch(() => null) as Record<string, unknown> | null;
    const action = input?.action;
    const backupType: BackupType = input?.backup_type === 'recovery' ? 'recovery' : 'account';
    const namespace = await opaqueNamespace(userId, namespaceSecret);
    const objectKey = `e2ee-backups/v1/${namespace}/${backupType}/latest.enc`;
    const config = loadR2Config();

    if (action === 'put') {
      const backup = validateEnvelope(input?.backup);
      if (!backup || backup.backup_type !== backupType) {
        return json(req, { error: 'Invalid encrypted backup envelope' }, 400);
      }
      const bytes = new TextEncoder().encode(JSON.stringify({
        schema: 'forsure-e2ee-r2-v1',
        backup,
      }));
      if (bytes.byteLength > MAX_BACKUP_BYTES) {
        return json(req, { error: 'Encrypted backup too large' }, 413);
      }
      const response = await r2Request(config, 'PUT', objectKey, bytes);
      if (!response.ok) {
        console.error('[e2ee-backup-vault] R2 PUT failed', response.status);
        return json(req, { error: 'Backup mirror write failed' }, 502);
      }
      return json(req, {
        ok: true,
        backup_type: backupType,
        version: backup.version,
        stored_at: new Date().toISOString(),
        digest: await sha256Hex(bytes),
      });
    }

    if (action === 'get') {
      const response = await r2Request(config, 'GET', objectKey);
      if (response.status === 404) return json(req, { ok: true, found: false });
      if (!response.ok) return json(req, { error: 'Backup mirror read failed' }, 502);

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BACKUP_BYTES) {
        return json(req, { error: 'Invalid backup mirror object' }, 502);
      }
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      const backup = parsed?.schema === 'forsure-e2ee-r2-v1'
        ? validateEnvelope(parsed.backup)
        : null;
      if (!backup || backup.backup_type !== backupType) {
        return json(req, { error: 'Corrupted backup mirror object' }, 502);
      }
      return json(req, {
        ok: true,
        found: true,
        backup,
        digest: await sha256Hex(bytes),
      });
    }

    if (action === 'delete') {
      const response = await r2Request(config, 'DELETE', objectKey);
      if (!response.ok && response.status !== 404) {
        return json(req, { error: 'Backup mirror delete failed' }, 502);
      }
      return json(req, { ok: true });
    }

    return json(req, { error: 'Unsupported action' }, 400);
  } catch (error) {
    console.error('[e2ee-backup-vault] request failed', error);
    return json(req, { error: 'Backup vault request failed' }, 500);
  }
});
