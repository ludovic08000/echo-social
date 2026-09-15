// Invariant : observer les contrôles réels, sans leurs entrées ni leurs secrets.
// Un contrôle absent n'est jamais déclaré réussi.
const CHECKS = {
  gateway: ['host', 'route', 'origin', 'bearer_syntax', 'request_json', 'database_rpc', 'database_response'],
  'sealed-mint-token': ['method', 'bearer_syntax', 'configuration', 'auth_session', 'request_shape', 'recipient', 'conversation_access', 'membership_lookup', 'sender_membership', 'recipient_membership', 'token_signing', 'token_persistence'],
  'sealed-relay': ['method', 'configuration', 'request_shape', 'payload_limits', 'token_decode', 'conversation_binding', 'recipient_binding', 'token_lifetime', 'token_mac', 'token_consume_and_relay'],
};

const CODES = new Set(`NOT_FOUND ORIGIN_DENIED NOT_AUTHENTICATED INVALID_JSON BODY_TOO_LARGE
UPSTREAM_TIMEOUT UPSTREAM_UNAVAILABLE UPSTREAM_INVALID_RESPONSE AEGIS_GATEWAY_FAILURE
E2EE_DEVICE_NOT_AUTHORIZED E2EE_DEVICE_COPIES_UNAVAILABLE AEGIS_PARTIAL_DEVICE_FANOUT
DEVICE_REVOKED DEVICE_NOT_APPROVED DEVICE_ROUTE_NOT_READY INVALID_REQUEST
UNAUTHORIZED METHOD_NOT_ALLOWED SEALED_SENDER_UNAVAILABLE INVALID_RECIPIENT CONTEXT_TOO_LARGE
CONVERSATION_NOT_FOUND CONVERSATION_MEMBERSHIP_DENIED SENDER_NOT_MEMBER RECIPIENT_NOT_MEMBER
TOKEN_PERSISTENCE_FAILED SENDER_TAG_TOO_LARGE SEALED_HEADER_TOO_LARGE SEALED_PAYLOAD_TOO_LARGE
CONVERSATION_MISMATCH RECIPIENT_MISMATCH TOKEN_EXPIRED TOKEN_NOT_YET_VALID TOKEN_INVALID_LIFETIME
INVALID_TOKEN_MAC TOKEN_CONSUMED RELAY_REJECTED INVALID_TOKEN INVALID_BASE64URL TOKEN_TOO_LARGE
TOKEN_NOT_FOUND TOKEN_MISMATCH TOKEN_CONTEXT_MISMATCH TOKEN_BINDING_MISMATCH
E2EE_INVALID_DEVICE_COPY E2EE_SENDER_DEVICE_REQUIRED E2EE_SENDER_DEVICE_NOT_TRUSTED
E2EE_DEVICE_LIST_STALE E2EE_NO_SECURE_TARGET E2EE_DUPLICATE_DEVICE_COPY E2EE_PARTICIPANT_ROUTE_UNAVAILABLE
AEGIS_WIRE_FORMAT_REJECTED AEGIS_STABLE_UUID_REQUIRED MESSAGE_ID_CONFLICT
SENDER_NOT_CONVERSATION_PARTICIPANT AEGIS_ACK_BATCH_INVALID UNSUPPORTED_PROTOCOL_VERSION
42501 28000 22023 23502 23505 23514 P0001 PGRST301 PGRST302 PGRST303`.split(/\s+/));

export function diagnosticCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return CODES.has(code) ? code : 'UNCLASSIFIED_ERROR';
}

export function diagnosticDebugActive(level, until, now = Date.now()) {
  const expires = Date.parse(until || '');
  // Date absolue obligatoire : un redémarrage ne prolonge pas le debug.
  return level === 'debug' && Number.isFinite(expires) && expires > now && expires - now <= 15 * 60_000;
}

export function createAegisDiagnostic(service, {
  logLevel, debugUntil, logger = (record) => console.log(JSON.stringify(record)), now = Date.now,
} = {}) {
  if (!Object.hasOwn(CHECKS, service)) throw new Error('Unknown diagnostic service');
  const id = globalThis.crypto.randomUUID();
  const started = now();
  const debugAtStart = diagnosticDebugActive(logLevel, debugUntil, started);
  const checks = Object.fromEntries(CHECKS[service].map((name) => [name, 'not_checked']));
  const timings = {};
  let current;
  let stepStarted = started;
  let finished = false;
  const completeStep = (result) => {
    if (!current) return;
    checks[current] = result;
    timings[current] = Math.max(0, now() - stepStarted);
  };
  return {
    id,
    // Juste AVANT le contrôle ; atteindre le suivant signifie que le précédent a passé.
    step(name) {
      if (finished || !Object.hasOwn(checks, name)) return;
      completeStep('pass');
      current = name;
      stepStarted = now();
      checks[name] = 'pending';
    },
    finish(status, code) {
      if (finished) return;
      finished = true;
      completeStep(status >= 400 ? 'fail' : 'pass');
      const debug = debugAtStart && diagnosticDebugActive(logLevel, debugUntil, now());
      const record = {
        timestamp: new Date(now()).toISOString(), event: 'aegis_checks', service,
        diagnostic_id: id, level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        status, duration_ms: Math.max(0, now() - started), debug,
        failed_check: status >= 400 ? current ?? 'not_checked' : null,
        error_code: status >= 400 ? diagnosticCode(code) : null,
        checks: { ...checks }, ...(debug ? { check_duration_ms: { ...timings } } : {}),
      };
      try { logger(record); } catch { /* Ne jamais changer le résultat métier. */ }
      return record;
    },
  };
}
