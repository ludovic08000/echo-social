// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { isPublicAppKey, verifyServiceReadiness } from '../../scripts/verify-service-readiness.mjs';

const publicKey = 'sb_publishable_synthetic';
const secureHeaders = {
  'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000', 'X-Content-Type-Options': 'nosniff',
};
function goodFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/feed')) return new Response(null, { headers: secureHeaders });
    if (url.endsWith('/version.json')) return Response.json({ version: '123456' });
    return Response.json({}, { headers: { 'Access-Control-Allow-Origin': 'https://forsure.fans' } });
  });
}

it('probes auth as well as HTML and requires an exact build for a verified release', async () => {
  const fetchImpl = goodFetch();
  const report = await verifyServiceReadiness({ publicKey, expectedBuild: '123456', fetchImpl });
  expect(report.releaseVerified).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  for (const [url, options] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
    expect(options.redirect).toBe('error');
    expect(options.credentials).toBe('omit');
    expect(options.method).toMatch(/^(GET|HEAD)$/);
    expect(Boolean((options.headers as Record<string, string>).apikey)).toBe(url.includes('/auth/v1/'));
  }
  expect((await verifyServiceReadiness({ publicKey, fetchImpl })).releaseVerified).toBe(false);
});

it.each([401, 521, 503])('does not count an auth gateway response %i as healthy', async status => {
  const otherwiseGood = goodFetch();
  const fetchImpl = vi.fn((url: string) => url.includes('/auth/v1/')
    ? Promise.resolve(new Response(null, { status })) : otherwiseGood(url));
  const report = await verifyServiceReadiness({ publicKey, fetchImpl });
  expect(report.passed).toBe(false);
  expect(report.checks.find(check => check.name === 'auth_health')?.passed).toBe(false);
});

it('rejects redirects, network errors and untrusted CORS without leaking their contents', async () => {
  const report = await verifyServiceReadiness({ publicKey, fetchImpl: async () => { throw new Error(publicKey); } });
  expect(report.passed).toBe(false);
  expect(JSON.stringify(report)).not.toContain(publicKey);
  const report2 = await verifyServiceReadiness({ publicKey, fetchImpl: async () => Response.json({}) });
  expect(report2.checks.find(check => check.name === 'auth_health')?.failures).toContain('AUTH_CORS_ORIGIN_NOT_ALLOWED');
});

it('fails closed on missing headers, stale versions and oversized responses', async () => {
  const report = await verifyServiceReadiness({ publicKey, expectedBuild: '999999', fetchImpl: goodFetch() });
  expect(report.checks.find(check => check.name === 'served_build')?.failures).toContain('SERVED_BUILD_MISMATCH');
  const missing = await verifyServiceReadiness({ publicKey, fetchImpl: async () => new Response('x'.repeat(5000)) });
  expect(missing.passed).toBe(false);
  expect(missing.checks.find(check => check.name === 'frontend_headers')?.passed).toBe(false);
  expect(missing.checks.find(check => check.name === 'served_build')?.passed).toBe(false);
});

it('rejects admin/secret keys before any request', async () => {
  const serviceKey = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
  const fetchImpl = vi.fn();
  for (const key of ['', 'sb_secret_synthetic', serviceKey]) {
    expect(isPublicAppKey(key)).toBe(false);
    await expect(verifyServiceReadiness({ publicKey: key, fetchImpl })).rejects.toThrow('PUBLIC_APP_KEY_REQUIRED');
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});
