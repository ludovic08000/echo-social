const CONFIG_KEYS = new Set(['scoring_weights', 'recency_tiers', 'time_of_day', 'velocity', 'marketplace_injection', 'anti_spam']);
export function feedConfigProposal(key: unknown, updates: unknown, reason: unknown) {
  if (typeof key !== 'string' || !CONFIG_KEYS.has(key) || typeof reason !== 'string' || !reason.trim() || reason.length > 1000
    || !updates || typeof updates !== 'object' || Array.isArray(updates)) return null;
  const entries = Object.entries(updates);
  if (!entries.length || entries.length > 40 || JSON.stringify(updates).length > 10000) return null;
  for (const [field, value] of entries) {
    if (!/^[a-zA-Z0-9_]+$/.test(field) || ['__proto__', 'constructor', 'prototype'].includes(field)) return null;
    if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > 1000000) return null; }
    else if (key === 'marketplace_injection' && field === 'positions' && Array.isArray(value)) {
      if (value.length > 30 || value.some(n => !Number.isSafeInteger(n) || n < 0 || n > 1000)) return null;
    } else if (typeof value !== 'boolean') return null;
  }
  return { key, updates: Object.fromEntries(entries), reason: reason.trim() };
}

/** Un appel du modèle ne constitue jamais la validation humaine d'une écriture. */
export function proposedFeedUpdate(args: any) {
  const proposal = feedConfigProposal(args?.key, args?.updates, args?.reason);
  return proposal ? { success: false, applied: false, approval_required: true, proposal: { action: 'update_algorithm_config', ...proposal } }
    : { success: false, applied: false, error: 'INVALID_FEED_PROPOSAL' };
}
