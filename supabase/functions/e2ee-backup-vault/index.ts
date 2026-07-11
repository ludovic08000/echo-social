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

interface EncryptedBackupEnvelope {
  encrypted_blob: string;
  iv: string;
  salt: string;
  wrapped_master_key: string;
  master_key_iv: string;
  version: number;
  backup_type: 'account' | 'recovery';
  created_at: string;
}

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+--[a-f0-9-]+\.lovable\.app$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.lovableproject\.com$/.test(origin)) return true;
  return false;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function validateBase64Like(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function validateEnvelope(value: unknown): EncryptedBackupEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (!validateBase64Like(row.encrypted_blob, MAX_BACKUP_BYTES * 2)) return null;
  if (!validateBase64Like(row.iv, 256)) return null;
  if (!validateBase64Like(row.salt, 512)) return null;
  if (!validateBase64Like(row.wrapped_master_key, 4096)) return null;
  if (!validateBase64Like(row.master_key_iv, 256)) return null;
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
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));
}

async function hmacBytes(key: Uint8Array, message: string): Promise<Uint8Array> {
  const raw = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)));
}

async function hmacString(key: string, message: string): Promise<Uint8Array> {
  return hmacBytes(new TextEncoder().encode(key), message);
}

async function opaqueUserNamespace(userId: string, namespaceSecret: string): Promise<string> {
  const digest = await hmacString(namespaceSecret, `forsure-r2-backup-v1:${userId}`);
  return toHex(digest);
}

interface R2Config {
  endpoint: string;
  host: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function loadR2Config(): R2Config {
  const accountId = Deno.env.get('R2_ACCOUNT_ID')?.trim() ?? '';
  let accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID')?.trim() ?? '';
  let secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY')?.trim() ?? '';
  const bucket = Deno.env.get('R2_BACKUP_BUCKET_NAME')?.trim() ?? '';
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

function buildAmzDate(now = new Date()): { amzDate: string; shortDate: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return { amzDate, shortDate: amzDate.slice(0, 8) };
}

async function signRequest(args: {
  method: 'GET' | 'PUT' | 'DELETE';
  canonicalPath: string;
  headers: Record<string, string>;
  payloadHash: string;
  amzDate: string;
  shortDate: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Promise<string> {
  const signedHeaderKeys = Object.keys(args.headers).map((key) => key.toLowerCase()).sort();
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.headers)) {
    normalizedHeaders[key.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalHeaders = signedHeaderKeys
    .map((key) => `${key}:${normalizedHeaders[key]}\n`)
    .join('');
  const canonicalRequest = [
    args.method,
    args.canonicalPath,
    '',
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join('\n');
  const scope = `${args.shortDate}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    args.amzDate,
    scope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join('\n');

  const kDate = await hmacString(`AWS4${args.secretAccessKey}`, args.shortDate);
  const kRegion = await hmacBytes(kDate, 'auto');
  const kService = await hmacBytes(kRegion, 's3');
  const kSigning = await hmacBytes(kService, 'aws4_request');
  const signature = toHex(await hmacBytes(kSigning, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function r2Request(args: {
  config: R2Config;
  method: 'GET' | 'PUT' | 'DELETE';
  objectKey: string;
  body?: Uint8Array;
}): Promise<Response> {
  const { amzDate, shortDate } = buildAmzDate();
  const payload = args.body ?? new Uint8Array(0);
  const payloadHash = await sha256Hex(payload);
  const canonicalPath = `/${args.config.bucket}/${args.objectKey}`;
  const headers: Record<string, string> = {
    host: args.config.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  if (args.method === 'PUT') {
    headers['content-type'] = 'application/octet-stream';
    headers['cache-control'] = 'private, no-store';
  }

  const authorization = await signRequest({
    method: args.method,
    canonicalPath,
    headers,
    payloadHash,
    amzDate,
    shortDate,
    accessKeyId: args.config.accessKeyId,
    secretAccessKey: args.config.secretAccessKey,
  });

  return fetch(`${args.config.endpoint}${canonicalPath}`, {
    method: args.method,
    headers: { ...headers, Authorization: authorization },
    body: args.method === 'PUT' ? payload : undefined,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  try {
    const authorization = req.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) {
      return json(req, { error: 'Not authenticated' }, 401);
    }

    const token = authorization.slice('Bearer '.length);
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

    const namespaceSecret = Deno.env.get('R2_BACKUP_NAMESPACE_SECRET')?.trim() ?? '';
    if (namespaceSecret.length < 32) {
      return json(req, { error: 'Backup vault unavailable' }, 503);
    }

    const config = loadR2Config();
    const input = await req.json().catch(() => null) as Record<string, unknown> | null;
    const action = input?.action;
    const backupType = input?.backup_type === 'recovery' ? 'recovery' : 'account';
    const namespace = await opaqueUserNamespace(userId, namespaceSecret);
    const objectKey = `e2ee-backups/v1/${namespace}/${backupType}/latest.enc`;

    if (action === 'put') {
      const backup = validateEnvelope(input?.backup);
      if (!backup || backup.backup_type !== backupType) {
        return json(req, { error: 'Invalid encrypted backup envelope' }, 400);
      }

      const vaultObject = {
        schema: 'forsure-e2ee-r2-v1',
        backup,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(vaultObject));
      if (bytes.byteLength > MAX_BACKUP_BYTES) {
        return json(req, { error: 'Encrypted backup too large' }, 413);
      }

      const response = await r2Request({ config, method: 'PUT', objectKey, body: bytes });
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
      const response = await r2Request({ config, method: 'GET', objectKey });
      if (response.status === 404) return json(req, { ok: true, found: false });
      if (!response.ok) {
        console.error('[e2ee-backup-vault] R2 GET failed', response.status);
        return json(req, { error: 'Backup mirror read failed' }, 502);
      }

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
      const response = await r2Request({ config, method: 'DELETE', objectKey });
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
