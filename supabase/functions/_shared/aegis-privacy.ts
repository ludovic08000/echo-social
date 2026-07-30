export type AegisPushKind =
  | "message"
  | "call_incoming"
  | "friend_request"
  | "security_alert"
  | "new_device"
  | "notification";

const PUSH_TEMPLATES: Record<AegisPushKind, { title: string; body: string; url: string; tag: string }> = {
  message: {
    title: "Nouveau message",
    body: "Ouvrez ForSure pour le consulter.",
    url: "/messages",
    tag: "forsure-message",
  },
  call_incoming: {
    title: "Appel entrant",
    body: "Ouvrez ForSure pour répondre.",
    url: "/messages",
    tag: "forsure-call",
  },
  friend_request: {
    title: "Nouvelle demande",
    body: "Une activité vous attend dans ForSure.",
    url: "/notifications",
    tag: "forsure-friend-request",
  },
  security_alert: {
    title: "Alerte de sécurité",
    body: "Vérifiez la sécurité de votre compte dans ForSure.",
    url: "/settings",
    tag: "forsure-security",
  },
  new_device: {
    title: "Nouvel appareil",
    body: "Vérifiez les appareils liés à votre compte.",
    url: "/settings",
    tag: "forsure-new-device",
  },
  notification: {
    title: "Nouvelle notification",
    body: "Ouvrez ForSure pour la consulter.",
    url: "/notifications",
    tag: "forsure-notification",
  },
};

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,80}$/;
const SAFE_META_KEYS = new Set([
  "status",
  "status_code",
  "attempt",
  "sent",
  "expired",
  "subscription_count",
  "kind",
  "role",
  "can_publish",
  "error_name",
  "error_code",
]);

export function normalizeAegisPushKind(value: unknown): AegisPushKind {
  return typeof value === "string" && value in PUSH_TEMPLATES
    ? value as AegisPushKind
    : "notification";
}

export function buildPrivacySafePushPayload(input: {
  kind?: unknown;
  requireInteraction?: unknown;
  timestamp?: number;
}): Record<string, unknown> {
  const kind = normalizeAegisPushKind(input.kind);
  const template = PUSH_TEMPLATES[kind];
  return {
    title: template.title,
    body: template.body,
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    url: template.url,
    tag: template.tag,
    kind,
    requireInteraction: kind === "call_incoming" || input.requireInteraction === true,
    timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
  };
}

export function safeServerErrorMeta(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { error_name: "unknown" };
  const value = error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  const result: Record<string, unknown> = {
    error_name: typeof value.name === "string" && SAFE_TOKEN.test(value.name) ? value.name : "unknown",
  };
  const code = value.code;
  if (typeof code === "string" && SAFE_TOKEN.test(code)) result.error_code = code;
  const status = value.status ?? value.statusCode;
  if (typeof status === "number" && Number.isFinite(status)) result.status_code = status;
  return result;
}

export function sanitizeServerLogMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_META_KEYS.has(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      safe[key] = value;
      continue;
    }
    if (typeof value === "string" && SAFE_TOKEN.test(value)) safe[key] = value;
  }
  return safe;
}

export function safeServerLog(
  scope: string,
  code: string,
  metadata: Record<string, unknown> = {},
): void {
  const safeScope = SAFE_TOKEN.test(scope) ? scope : "server";
  const safeCode = SAFE_TOKEN.test(code) ? code : "UNCLASSIFIED";
  console.warn(`[PRIVACY:${safeScope}] ${safeCode}`, sanitizeServerLogMetadata(metadata));
}
