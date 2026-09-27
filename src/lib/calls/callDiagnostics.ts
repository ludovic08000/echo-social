export type CallDiagnosticOutcome = 'start' | 'ok' | 'skip' | 'error';
export type CallDiagnosticDirection = 'local' | 'outgoing' | 'incoming';

export interface CallDiagnosticEvent {
  at: string;
  seq: number;
  direction: CallDiagnosticDirection;
  stage: string;
  outcome: CallDiagnosticOutcome;
  callRef?: string;
  conversationRef?: string;
  deviceRef?: string;
  elapsedMs?: number;
  errorCode?: AegisCallErrorCode;
  diagnosticId?: string;
}

export type AegisCallErrorCode =
  | 'CALLS_DISABLED'
  | 'CALL_ALREADY_ACTIVE'
  | 'CALL_INVALID_REQUEST'
  | 'CALL_HAS_NO_INVITEES'
  | 'CALL_INVITEE_LIMIT_EXCEEDED'
  | 'CALL_RECIPIENT_HAS_NO_CANONICAL_DEVICE'
  | 'CALL_RECIPIENT_HAS_NO_ROUTABLE_DEVICE'
  | 'CALL_CURRENT_DEVICE_NOT_READY'
  | 'CALL_CREATE_REJECTED'
  | 'CALL_INVITATION_NOT_FOUND'
  | 'CALL_INVITATION_INVALID'
  | 'CALL_KEY_INVALID'
  | 'CALL_NOT_AUTHENTICATED'
  | 'CALL_AUTH_REFRESH_FAILED'
  | 'CALL_TOKEN_REQUEST_FAILED'
  | 'CALL_TOKEN_RESPONSE_INVALID'
  | 'CALL_TOKEN_TIMEOUT'
  | 'CALL_SERVICE_UNAVAILABLE'
  | 'CALL_RATE_LIMITED'
  | 'CALL_NOT_JOINABLE'
  | 'CALL_DEVICE_NOT_AUTHORIZED'
  | 'CALL_DEVICE_NOT_INVITED'
  | 'CALL_E2EE_UNSUPPORTED'
  | 'CALL_MEDIA_PERMISSION_DENIED'
  | 'CALL_E2EE_INIT_FAILED'
  | 'CALL_ROOM_CONNECT_TIMEOUT'
  | 'CALL_ROOM_CONNECT_FAILED'
  | 'CALL_E2EE_ENABLE_FAILED'
  | 'CALL_TRACK_PUBLISH_FAILED'
  | 'CALL_STATUS_UPDATE_FAILED'
  | 'CALL_INTERNAL_ERROR';

const ERROR_CODES = new Set<AegisCallErrorCode>([
  'CALLS_DISABLED',
  'CALL_ALREADY_ACTIVE',
  'CALL_INVALID_REQUEST',
  'CALL_HAS_NO_INVITEES',
  'CALL_INVITEE_LIMIT_EXCEEDED',
  'CALL_RECIPIENT_HAS_NO_CANONICAL_DEVICE',
  'CALL_RECIPIENT_HAS_NO_ROUTABLE_DEVICE',
  'CALL_CURRENT_DEVICE_NOT_READY',
  'CALL_CREATE_REJECTED',
  'CALL_INVITATION_NOT_FOUND',
  'CALL_INVITATION_INVALID',
  'CALL_KEY_INVALID',
  'CALL_NOT_AUTHENTICATED',
  'CALL_AUTH_REFRESH_FAILED',
  'CALL_TOKEN_REQUEST_FAILED',
  'CALL_TOKEN_RESPONSE_INVALID',
  'CALL_TOKEN_TIMEOUT',
  'CALL_SERVICE_UNAVAILABLE',
  'CALL_RATE_LIMITED',
  'CALL_NOT_JOINABLE',
  'CALL_DEVICE_NOT_AUTHORIZED',
  'CALL_DEVICE_NOT_INVITED',
  'CALL_E2EE_UNSUPPORTED',
  'CALL_MEDIA_PERMISSION_DENIED',
  'CALL_E2EE_INIT_FAILED',
  'CALL_ROOM_CONNECT_TIMEOUT',
  'CALL_ROOM_CONNECT_FAILED',
  'CALL_E2EE_ENABLE_FAILED',
  'CALL_TRACK_PUBLISH_FAILED',
  'CALL_STATUS_UPDATE_FAILED',
  'CALL_INTERNAL_ERROR',
]);

const SERVER_CODE_MAP: Record<string, AegisCallErrorCode> = {
  NOT_AUTHENTICATED: 'CALL_NOT_AUTHENTICATED',
  UNAUTHORIZED: 'CALL_NOT_AUTHENTICATED',
  INVALID_REQUEST: 'CALL_INVALID_REQUEST',
  CALL_SERVICE_UNAVAILABLE: 'CALL_SERVICE_UNAVAILABLE',
  CALL_RATE_LIMITED: 'CALL_RATE_LIMITED',
  CALL_NOT_JOINABLE: 'CALL_NOT_JOINABLE',
  CALL_STATE_LOOKUP_FAILED: 'CALL_SERVICE_UNAVAILABLE',
  CALL_DEVICE_LOOKUP_FAILED: 'CALL_SERVICE_UNAVAILABLE',
  CALL_INVITATION_LOOKUP_FAILED: 'CALL_SERVICE_UNAVAILABLE',
  CALL_DEVICE_NOT_AUTHORIZED: 'CALL_DEVICE_NOT_AUTHORIZED',
  CALL_DEVICE_NOT_INVITED: 'CALL_DEVICE_NOT_INVITED',
};

const MAX_EVENTS = 160;
const SAFE_STAGE = /^[A-Za-z0-9_.:-]{1,80}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const events: CallDiagnosticEvent[] = [];
const references = new Map<string, string>();
const counters = new Map<string, number>();
let sequence = 0;

function reference(kind: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const key = `${kind}:${value}`;
  const current = references.get(key);
  if (current) return current;
  const next = (counters.get(kind) ?? 0) + 1;
  counters.set(kind, next);
  const result = `${kind}-${String(next).padStart(3, '0')}`;
  if (references.size >= 640) references.delete(references.keys().next().value!);
  references.set(key, result);
  return result;
}

function safeElapsed(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export class AegisCallError extends Error {
  readonly code: AegisCallErrorCode;
  readonly diagnosticId?: string;

  constructor(code: AegisCallErrorCode, options: { cause?: unknown; diagnosticId?: string } = {}) {
    super(code);
    this.name = 'AegisCallError';
    this.code = code;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
    if (options.diagnosticId && UUID_V4.test(options.diagnosticId)) {
      this.diagnosticId = options.diagnosticId;
    }
  }
}

export function normalizeAegisCallError(
  error: unknown,
  fallback: AegisCallErrorCode = 'CALL_INTERNAL_ERROR',
): AegisCallError {
  if (error instanceof AegisCallError) return error;
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const head = raw.split(':', 1)[0].trim().toUpperCase();
  if (ERROR_CODES.has(head as AegisCallErrorCode)) {
    return new AegisCallError(head as AegisCallErrorCode, { cause: error });
  }
  const mapped = SERVER_CODE_MAP[head];
  return new AegisCallError(mapped ?? fallback, { cause: error });
}

export function callErrorFromServer(
  code: unknown,
  fallback: AegisCallErrorCode,
  diagnosticId?: string | null,
  cause?: unknown,
): AegisCallError {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const mapped = ERROR_CODES.has(normalized as AegisCallErrorCode)
    ? normalized as AegisCallErrorCode
    : SERVER_CODE_MAP[normalized] ?? fallback;
  return new AegisCallError(mapped, {
    cause,
    diagnosticId: diagnosticId ?? undefined,
  });
}

export function callErrorUserMessage(error: unknown): string {
  const normalized = normalizeAegisCallError(error);
  const messages: Partial<Record<AegisCallErrorCode, string>> = {
    CALLS_DISABLED: 'Les appels sont temporairement désactivés. Les messages restent disponibles.',
    CALL_ALREADY_ACTIVE: 'Un appel est déjà en cours.',
    CALL_INVALID_REQUEST: "La demande d'appel est invalide.",
    CALL_HAS_NO_INVITEES: "Aucun destinataire valide pour cet appel.",
    CALL_INVITEE_LIMIT_EXCEEDED: "Trop de participants pour cet appel sécurisé.",
    CALL_RECIPIENT_HAS_NO_CANONICAL_DEVICE: "Le destinataire doit d'abord ouvrir ForSure et finaliser son appareil sécurisé.",
    CALL_RECIPIENT_HAS_NO_ROUTABLE_DEVICE: "Aucun appareil sécurisé du destinataire n'est actuellement joignable.",
    CALL_CURRENT_DEVICE_NOT_READY: "Ton appareil sécurisé n'est pas encore prêt pour les appels.",
    CALL_CREATE_REJECTED: "Le serveur n'a pas pu créer cet appel sécurisé.",
    CALL_KEY_INVALID: "La clé chiffrée de l'appel est invalide.",
    CALL_NOT_AUTHENTICATED: 'Ta session a expiré. Reconnecte-toi puis réessaie.',
    CALL_AUTH_REFRESH_FAILED: 'Impossible de renouveler ta session pour cet appel.',
    CALL_TOKEN_TIMEOUT: "Le serveur d'appel met trop de temps à répondre.",
    CALL_TOKEN_REQUEST_FAILED: "Impossible d'obtenir l'autorisation de rejoindre l'appel.",
    CALL_TOKEN_RESPONSE_INVALID: "La réponse du serveur d'appel est invalide.",
    CALL_SERVICE_UNAVAILABLE: "Le serveur d'appel est momentanément indisponible.",
    CALL_RATE_LIMITED: "Trop de tentatives d'appel. Patiente une minute.",
    CALL_NOT_JOINABLE: "Cet appel n'est plus disponible.",
    CALL_DEVICE_NOT_AUTHORIZED: "Cet appareil n'est pas autorisé à rejoindre l'appel.",
    CALL_DEVICE_NOT_INVITED: "Cet appareil n'a pas reçu l'invitation chiffrée.",
    CALL_E2EE_UNSUPPORTED: "Ce navigateur ne prend pas en charge les appels chiffrés.",
    CALL_MEDIA_PERMISSION_DENIED: "Autorise le micro et la caméra pour démarrer l'appel.",
    CALL_E2EE_INIT_FAILED: "Le chiffrement de l'appel n'a pas pu être initialisé.",
    CALL_ROOM_CONNECT_TIMEOUT: "La connexion à l'appel a expiré.",
    CALL_ROOM_CONNECT_FAILED: "La connexion au serveur d'appel a échoué.",
    CALL_E2EE_ENABLE_FAILED: "Le chiffrement de l'appel n'a pas pu être activé.",
    CALL_TRACK_PUBLISH_FAILED: "Le micro ou la caméra n'a pas pu être activé.",
    CALL_STATUS_UPDATE_FAILED: "L'état de l'appel n'a pas pu être mis à jour.",
    CALL_INVITATION_NOT_FOUND: "L'invitation d'appel n'est plus disponible.",
    CALL_INVITATION_INVALID: "L'invitation d'appel ne correspond pas à cette conversation.",
  };
  const base = messages[normalized.code] ?? "Impossible de démarrer l'appel sécurisé.";
  return normalized.diagnosticId ? `${base} Diagnostic : ${normalized.diagnosticId}` : base;
}

export function traceCall(input: {
  direction: CallDiagnosticDirection;
  stage: string;
  outcome: CallDiagnosticOutcome;
  callId?: string;
  conversationId?: string;
  deviceId?: string;
  elapsedMs?: number;
  errorCode?: string;
  diagnosticId?: string;
}): void {
  const normalizedError = input.errorCode
    ? normalizeAegisCallError(input.errorCode).code
    : undefined;
  const event: CallDiagnosticEvent = {
    at: new Date().toISOString(),
    seq: ++sequence,
    direction: input.direction,
    stage: SAFE_STAGE.test(input.stage) ? input.stage : 'unclassified',
    outcome: input.outcome,
  };
  event.callRef = reference('call', input.callId);
  event.conversationRef = reference('conv', input.conversationId);
  event.deviceRef = reference('dev', input.deviceId);
  event.elapsedMs = safeElapsed(input.elapsedMs);
  event.errorCode = normalizedError;
  if (typeof input.diagnosticId === 'string' && UUID_V4.test(input.diagnosticId)) {
    event.diagnosticId = input.diagnosticId;
  }
  for (const key of Object.keys(event) as Array<keyof CallDiagnosticEvent>) {
    if (event[key] === undefined) delete event[key];
  }
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('forsure:call-trace'));
  }
}

export function readCallTrace(): CallDiagnosticEvent[] {
  return events.map((event) => ({ ...event }));
}

export function clearCallTrace(): void {
  events.length = 0;
  references.clear();
  counters.clear();
  sequence = 0;
}
