const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = String(process.env.SUPABASE_ANON_KEY || '');
const response = await fetch(`${url}/auth/v1/signup`, {
  method: 'POST',
  headers: {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    data: { aegis_test_probe: true },
    gotrue_meta_security: {},
  }),
  redirect: 'error',
});
const payload = await response.json().catch(() => null);
const result = {
  status: response.status,
  ok: response.ok,
  code: payload?.code || payload?.error_code || null,
  message: payload?.message || payload?.msg || payload?.error_description || null,
  has_access_token: Boolean(payload?.access_token),
  has_user: Boolean(payload?.user?.id),
  is_anonymous: payload?.user?.is_anonymous === true,
};
console.log(`AEGIS_ANONYMOUS_AUTH_PROBE ${JSON.stringify(result)}`);
if (!response.ok || !payload?.access_token) process.exitCode = 1;
