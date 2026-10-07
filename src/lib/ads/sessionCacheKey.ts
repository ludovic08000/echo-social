// Cache partition only. Authorization and session identity are always verified by Lovable Cloud.
// Never put an access/refresh token in a query key or logs.
export function adSessionCacheKey(accessToken: string | undefined): string | null {
  try {
    const payload = accessToken?.split('.')[1];
    if (!payload) return null;
    const { session_id: id } = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
  } catch { return null; }
}
