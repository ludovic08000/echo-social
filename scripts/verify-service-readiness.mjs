import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { servedSecurityFailures } from './verify-served-security.mjs';

const SITE = 'https://forsure.fans';
const BACKEND = 'https://vkpmoqfzrihcijjochks.supabase.co';

// Public keys only. Never accept an admin credential for a public availability probe.
export function isPublicAppKey(key) {
  if (typeof key !== 'string' || key.length > 4096) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  try {
    const parts = key.split('.');
    return parts.length === 3 && JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role === 'anon';
  } catch { return false; }
}

/** Non-mutating probes, not a real-user login or an ISO certificate. */
export async function verifyServiceReadiness({ publicKey, expectedBuild, fetchImpl = fetch } = {}) {
  if (!isPublicAppKey(publicKey)) throw new Error('PUBLIC_APP_KEY_REQUIRED');
  if (expectedBuild !== undefined && !/^\d{1,20}$/.test(String(expectedBuild))) {
    throw new Error('INVALID_EXPECTED_BUILD');
  }
  const checks = await Promise.all([
    ['frontend_headers', `${SITE}/feed`, 'HEAD'],
    ['auth_health', `${BACKEND}/auth/v1/health`, 'GET'],
    ['auth_settings', `${BACKEND}/auth/v1/settings`, 'GET'],
    ['served_build', `${SITE}/version.json`, 'GET'],
  ].map(async ([name, url, method]) => {
    const auth = name.startsWith('auth_');
    try {
      const response = await fetchImpl(url, {
        method, redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: AbortSignal.timeout(10_000),
        headers: auth ? { apikey: publicKey, Origin: SITE } : {},
      });
      const failures = response.ok ? [] : ['HTTP_NOT_OK'];
      if (name === 'frontend_headers') failures.push(...servedSecurityFailures(response.headers));
      if (auth) {
        const origin = response.headers.get('access-control-allow-origin');
        if (origin !== SITE && origin !== '*') failures.push('AUTH_CORS_ORIGIN_NOT_ALLOWED');
      }
      let version;
      if (name === 'served_build' && response.ok) {
        const contentLength = response.headers.get('content-length');
        if (contentLength && Number(contentLength) > 4096) throw new Error('RESPONSE_TOO_LARGE');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('INVALID_BUILD_RESPONSE');
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) throw new Error('RESPONSE_TOO_LARGE');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const candidate = String(data.buildVersion ?? data.version ?? '');
        if (!/^\d{1,20}$/.test(candidate)) failures.push('INVALID_SERVED_BUILD');
        else version = candidate;
        if (expectedBuild !== undefined && version !== String(expectedBuild)) failures.push('SERVED_BUILD_MISMATCH');
      }
      return { name, status: response.status, passed: failures.length === 0, failures,
        ...(version ? { version } : {}) };
    } catch {
      // Do not serialize arbitrary exception messages, headers or response bodies.
      return { name, passed: false, failures: ['PROBE_UNAVAILABLE_OR_INVALID'] };
    }
  }));
  return {
    checkedAt: new Date().toISOString(), site: SITE, backend: BACKEND,
    passed: checks.every(check => check.passed),
    buildComparison: expectedBuild === undefined ? 'not_checked' : 'checked',
    releaseVerified: expectedBuild !== undefined && checks.every(check => check.passed),
    checks,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await verifyServiceReadiness({
      publicKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY,
      expectedBuild: process.env.EXPECTED_BUILD_VERSION,
    });
    console.log(JSON.stringify(report));
    if (!report.passed) process.exitCode = 1;
  } catch {
    console.error('READINESS_CONFIGURATION_INVALID: public application key and optional numeric build required');
    process.exitCode = 1;
  }
}
