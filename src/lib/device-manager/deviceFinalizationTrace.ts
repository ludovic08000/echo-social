/**
 * Autorité de trace de la finalisation appareil (Aegis).
 *
 * Invariant : cette autorité observe, elle ne décide jamais. Elle n'altère ni
 * l'ordre canonique ni le comportement cryptographique. Aucun secret ne peut
 * entrer dans le tampon : identifiants masqués par empreinte locale courte,
 * codes d'erreur normalisés sur une liste blanche, snapshot d'état strictement
 * limité aux statuts serveur du cycle de vie.
 */

export type DeviceFinalizationOutcome =
  | 'start'
  | 'success'
  | 'failure'
  | 'timeout'
  | 'skipped'
  | 'info'
  | 'retry'
  | 'stalled';

export interface DeviceFinalizationStateSnapshot {
  approvalStatus?: string | null;
  bindingStatus?: string | null;
  routingStatus?: string | null;
  lifecycleStatus?: string | null;
  isActive?: boolean | null;
  revoked?: boolean | null;
}

export interface DeviceFinalizationTraceInput {
  traceId: string;
  step: string;
  outcome: DeviceFinalizationOutcome;
  elapsedMs?: number;
  attempt?: number;
  errorCode?: unknown;
  userId?: string | null;
  deviceId?: string | null;
  state?: DeviceFinalizationStateSnapshot | null;
  /** Détail non sensible, normalisé en majuscules (ex. source de restauration). */
  detail?: string | null;
}

export interface DeviceFinalizationTraceEvent {
  at: string;
  traceId: string;
  step: string;
  outcome: DeviceFinalizationOutcome;
  seq: number;
  elapsedMs?: number;
  attempt?: number;
  errorCode?: string;
  userRef?: string;
  deviceRef?: string;
  state?: DeviceFinalizationStateSnapshot;
  detail?: string;
}

const MAX_EVENTS = 200;
const TRACE_PREFIX = '[E2EE_TRACE][DEVICE_FINALIZATION]';
export const DEVICE_FINALIZATION_TRACE_EVENT = 'forsure:device-finalization-trace';

const buffer: DeviceFinalizationTraceEvent[] = [];
let sequence = 0;

/** Empreinte locale courte, non réversible, jamais l'identifiant complet. */
export function maskIdentifier(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `#${hash.toString(16).padStart(8, '0')}`;
}

const ALLOWED_ERROR_CODES = new Set([
  'ACCOUNT_KEY_RESTORE_REQUIRED',
  'ACCOUNT_SYNC_USER_REQUIRED',
  'DEVICE_ACCOUNT_BINDING_FAILED',
  'DEVICE_AUTO_APPROVAL_NOT_PENDING',
  'DEVICE_AUTO_APPROVAL_RESULT_INVALID',
  'DEVICE_ENROLLMENT_NOT_PENDING',
  'DEVICE_KEY_SETUP_INCOMPLETE',
  'DEVICE_LIFECYCLE_STALLED',
  'DEVICE_LOCAL_KEY_MISMATCH',
  'DEVICE_LOCAL_PRIVATE_KEYS_MISSING',
  'DEVICE_LOOKUP_FAILED',
  'DEVICE_MAINTENANCE_NOT_READY',
  'DEVICE_NOT_APPROVED',
  'DEVICE_NOT_FOUND',
  'DEVICE_NOT_READY_FOR_KEYS',
  'DEVICE_REVOKED',
  'DEVICE_ROUTE_NOT_READY',
  'DEVICE_STATE_LOOKUP_FAILED',
  'DEVICE_SYNCHRONIZATION_INCOMPLETE',
  'DEVICE_VAULT_RECOVERY_REQUIRED',
  'DEVICE_X3DH_VAULT_BACKUP_REQUIRED',
  'E2EE_CRYPTO_API_NOT_READY',
]);

/**
 * Normalise toute erreur en code allowlisté : jamais de message serveur brut,
 * qui pourrait transporter des données sensibles.
 */
export function normalizeFinalizationErrorCode(error: unknown): string {
  if (error === null || error === undefined) return 'UNKNOWN_ERROR';
  const raw = error instanceof Error ? error.message : String(error);
  const head = raw.split(':')[0]?.trim().toUpperCase() ?? '';
  if (ALLOWED_ERROR_CODES.has(head)) return head;
  if (/_TIMEOUT$/.test(head) && /^DEVICE_[A-Z0-9_]+$/.test(head)) return head;
  const upper = raw.toUpperCase();
  for (const code of ALLOWED_ERROR_CODES) {
    if (upper.includes(code)) return code;
  }
  if (/TIMEOUT/.test(upper)) return 'TIMEOUT';
  if (/NETWORK|FETCH|OFFLINE/.test(upper)) return 'NETWORK_ERROR';
  return 'UNKNOWN_ERROR';
}

function sanitizeState(state: DeviceFinalizationStateSnapshot | null | undefined) {
  if (!state) return undefined;
  const safe: DeviceFinalizationStateSnapshot = {};
  if (state.approvalStatus !== undefined) safe.approvalStatus = state.approvalStatus ?? null;
  if (state.bindingStatus !== undefined) safe.bindingStatus = state.bindingStatus ?? null;
  if (state.routingStatus !== undefined) safe.routingStatus = state.routingStatus ?? null;
  if (state.lifecycleStatus !== undefined) safe.lifecycleStatus = state.lifecycleStatus ?? null;
  if (state.isActive !== undefined) safe.isActive = state.isActive ?? null;
  if (state.revoked !== undefined) safe.revoked = state.revoked ?? null;
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function sanitizeDetail(detail: string | null | undefined): string | undefined {
  if (!detail) return undefined;
  const normalized = detail.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48).toUpperCase();
  return normalized || undefined;
}

/** Construit l'événement assaini sans l'enregistrer (utilisé par les tests). */
export function sanitizeDeviceFinalizationEvent(
  input: DeviceFinalizationTraceInput,
  seq: number,
): DeviceFinalizationTraceEvent {
  const event: DeviceFinalizationTraceEvent = {
    at: new Date().toISOString(),
    traceId: input.traceId,
    step: input.step,
    outcome: input.outcome,
    seq,
  };
  if (typeof input.elapsedMs === 'number') event.elapsedMs = Math.max(0, Math.round(input.elapsedMs));
  if (typeof input.attempt === 'number') event.attempt = input.attempt;
  if (input.errorCode !== undefined) event.errorCode = normalizeFinalizationErrorCode(input.errorCode);
  const userRef = maskIdentifier(input.userId);
  if (userRef) event.userRef = userRef;
  const deviceRef = maskIdentifier(input.deviceId);
  if (deviceRef) event.deviceRef = deviceRef;
  const state = sanitizeState(input.state);
  if (state) event.state = state;
  const detail = sanitizeDetail(input.detail);
  if (detail) event.detail = detail;
  return event;
}

export function traceDeviceFinalization(input: DeviceFinalizationTraceInput): DeviceFinalizationTraceEvent {
  sequence += 1;
  const event = sanitizeDeviceFinalizationEvent(input, sequence);
  buffer.push(event);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);

  try {
    console.info(TRACE_PREFIX, event);
  } catch {
    // La journalisation console est facultative.
  }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(DEVICE_FINALIZATION_TRACE_EVENT, { detail: event }));
    }
  } catch {
    // L'observation externe est best-effort.
  }
  return event;
}

export function getDeviceFinalizationTrace(limit?: number): DeviceFinalizationTraceEvent[] {
  const events = buffer.map((event) => ({ ...event }));
  return typeof limit === 'number' && limit > 0 ? events.slice(-limit) : events;
}

export function clearDeviceFinalizationTrace(): void {
  buffer.length = 0;
}

export function newDeviceFinalizationTraceId(): string {
  const random = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `dft_${Date.now().toString(36)}_${random}`;
}

/** Chronomètre partagé pour renseigner `elapsedMs` sur chaque étape. */
export function startFinalizationTimer(): () => number {
  const startedAt = Date.now();
  return () => Date.now() - startedAt;
}

/**
 * Contexte de trace courant : permet aux fonctions bas niveau (deviceApi,
 * accountKeySync) de rattacher leurs événements au même traceId de pipeline
 * sans changer leur signature publique.
 */
let currentTraceId: string | null = null;

export function setCurrentDeviceFinalizationTraceId(traceId: string | null): void {
  currentTraceId = traceId;
}

export function getCurrentDeviceFinalizationTraceId(): string {
  return currentTraceId ?? 'dft_orphan';
}

export function traceCurrentDeviceFinalization(
  input: Omit<DeviceFinalizationTraceInput, 'traceId'> & { traceId?: string },
): DeviceFinalizationTraceEvent {
  return traceDeviceFinalization({ ...input, traceId: input.traceId ?? getCurrentDeviceFinalizationTraceId() });
}

export const DEVICE_FINALIZATION_TRACE_MAX_EVENTS = MAX_EVENTS;
