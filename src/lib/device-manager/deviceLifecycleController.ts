/**
 * Autorité unique du cycle de vie appareil (Aegis).
 *
 * Invariant cryptographique : il n'existe qu'UNE seule machine d'état par
 * compte. Tous les écrans (App, DeviceApprovalGate, DevicesPanel,
 * PinValidatedMessaging…) observent ce contrôleur au lieu de piloter chacun
 * leur propre enrôlement/approbation/binding, ce qui provoquait des appels
 * concurrents, des lectures serveur en rafale et des écrans d'attente infinis.
 *
 * Ordre canonique, sans variante ni chemin PIN-first :
 * AUTHENTICATED -> DEVICE_CREDENTIAL_CHECK -> LINK_REQUIRED/PENDING_APPROVAL
 * -> APPROVED_LOCKED -> PIN_UNLOCK -> ACCOUNT_BINDING -> DEVICE_KEY_SETUP
 * -> ACCOUNT_KEY_SYNC -> MESSAGING_READY
 *
 * Le contrôleur ne fabrique jamais un état « ready » : chaque transition est
 * relue depuis le serveur. Toute erreur est exposée (fail-closed + retry) et
 * n'est jamais masquée par un spinner permanent.
 */
import {
  newDeviceFinalizationTraceId,
  setCurrentDeviceFinalizationTraceId,
  startFinalizationTimer,
  traceDeviceFinalization,
} from './deviceFinalizationTrace';
import {
  canPromptForPin,
  canRunCryptoRuntime,
  canRunDeviceKeySetup,
  requiresDeviceApprovalUi,
  resolveDeviceLifecycleState,
  type AegisDeviceLifecycleState,
  type DeviceIdStatus,
  type DeviceLifecycleReason,
  type DeviceLifecycleRecord,
} from './deviceLifecycleMachine';

export type DeviceLifecycleStage =
  | 'idle'
  | 'reading'
  | 'enrolling'
  | 'approving'
  | 'binding'
  | 'preparing_keys'
  | 'syncing_account';

export type AccountSyncPhase = 'idle' | 'syncing' | 'ready' | 'failed';

export interface DeviceLifecycleSnapshot {
  state: AegisDeviceLifecycleState;
  reason: DeviceLifecycleReason;
  deviceId: string | null;
  deviceIdStatus: DeviceIdStatus;
  record: DeviceLifecycleRecord | null;
  loading: boolean;
  stage: DeviceLifecycleStage;
  error: string | null;
  pinUnlocked: boolean;
  accountSyncPhase: AccountSyncPhase;
  canPromptForPin: boolean;
  canRunDeviceKeySetup: boolean;
  canRunCryptoRuntime: boolean;
  needsApprovalUi: boolean;
  canStartEnrollment: boolean;
}

interface ApiRecordLike {
  deviceId: string;
  approvalStatus: DeviceLifecycleRecord['approvalStatus'];
  bindingStatus: DeviceLifecycleRecord['bindingStatus'];
  routingStatus: DeviceLifecycleRecord['routingStatus'];
  isActive: boolean | null;
  revokedAt: string | null;
  lifecycleStatus?: string | null;
}

export interface DeviceLifecycleApi {
  getState(userId: string): Promise<{ record: ApiRecordLike | null }>;
  enroll(userId: string): Promise<unknown>;
  autoApprove(userId: string): Promise<unknown>;
  bind(userId: string): Promise<unknown>;
  prepareKeys(userId: string): Promise<unknown>;
  /**
   * Synchronisation de compte réellement exécutée et prouvée : sans elle la
   * messagerie ne s'ouvre jamais (aucun MESSAGING_READY simulé).
   */
  syncAccount(userId: string): Promise<unknown>;
  /**
   * Finalisation serveur (`complete_current_device_synchronization`) appelée
   * uniquement après une synchronisation de compte réellement réussie.
   */
  finalizeSynchronization(userId: string): Promise<unknown>;
}

const LIFECYCLE_STATUSES = ['pending', 'approved', 'syncing', 'ready', 'revoked'] as const;

function normalizeLifecycleStatus(raw: string | null | undefined): DeviceLifecycleRecord['lifecycleStatus'] {
  if (!raw) return null;
  return (LIFECYCLE_STATUSES as readonly string[]).includes(raw)
    ? (raw as DeviceLifecycleRecord['lifecycleStatus'])
    : null;
}

export interface DeviceLifecycleDeps {
  api: DeviceLifecycleApi;
  hydrateDeviceId(): Promise<unknown>;
  getDeviceIdStatus(): DeviceIdStatus;
  peekDeviceId(): string | null;
  setUserScope(userId: string | null): void;
  isWindowsWeb(): boolean;
  readPinUnlocked(userId: string): boolean;
  subscribePinUnlocked(userId: string, listener: (unlocked: boolean) => void): () => void;
  onDeviceRecordChanged(userId: string, listener: () => void): () => void;
  pinRequired: boolean;
  stepTimeoutMs: number;
  log?(stage: string, details: Record<string, unknown>, level?: 'info' | 'warn' | 'error'): void;
}

const DEFAULT_STEP_TIMEOUT_MS = 90_000;
const MAX_PIPELINE_STEPS = 8;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'UNKNOWN_ERROR');
}

async function withStepTimeout<T>(stage: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DEVICE_${stage.toUpperCase()}_TIMEOUT`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function recordKey(record: DeviceLifecycleRecord | null): string {
  if (!record) return 'null';
  return [
    record.deviceId,
    record.approvalStatus,
    record.bindingStatus,
    record.routingStatus,
    record.lifecycleStatus,
    record.isActive,
    record.revokedAt,
  ].join('|');
}

export class DeviceLifecycleController {
  private readonly listeners = new Set<(snapshot: DeviceLifecycleSnapshot) => void>();
  private readonly deps: DeviceLifecycleDeps;
  private readonly userId: string;

  private record: DeviceLifecycleRecord | null | 'unknown' = 'unknown';
  private recordSignature = 'unknown';
  private deviceId: string | null = null;
  private deviceIdStatus: DeviceIdStatus = 'uninitialized';
  private pinUnlocked = false;
  private accountSyncPhase: AccountSyncPhase = 'idle';
  private stage: DeviceLifecycleStage = 'idle';
  private error: string | null = null;
  private manualEnrollmentRequested = false;
  private blockedUntilRetry = false;
  private disposed = false;
  /** Corrélation d'une tentative complète de pipeline (diagnostic seulement). */
  private traceId = newDeviceFinalizationTraceId();
  private readonly stepAttempts = new Map<string, number>();


  private snapshot!: DeviceLifecycleSnapshot;
  private readPromise: Promise<void> | null = null;
  private pipelinePromise: Promise<void> | null = null;
  private teardown: Array<() => void> = [];

  constructor(userId: string, deps: DeviceLifecycleDeps) {
    this.userId = userId;
    this.deps = deps;
    this.deps.setUserScope(userId);
    this.pinUnlocked = deps.readPinUnlocked(userId);
    this.snapshot = this.computeSnapshot();

    this.teardown.push(deps.subscribePinUnlocked(userId, (unlocked) => {
      if (this.disposed || this.pinUnlocked === unlocked) return;
      this.pinUnlocked = unlocked;
      this.publish();
      void this.advance();
    }));
    this.teardown.push(deps.onDeviceRecordChanged(userId, () => {
      if (!this.disposed) void this.advance();
    }));

    void this.advance();
  }

  getSnapshot(): DeviceLifecycleSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: DeviceLifecycleSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Relit l'état serveur puis poursuit le flux canonique si nécessaire. */
  refresh(): Promise<void> {
    return this.advance();
  }

  /** Sortie explicite d'un état d'erreur : réarme le flux canonique. */
  retry(): Promise<void> {
    this.error = null;
    if (this.accountSyncPhase === 'failed') this.accountSyncPhase = 'idle';
    this.blockedUntilRetry = false;
    this.publish();
    return this.advance();
  }

  /** Windows Web : enrôlement d'un nouvel appareil sur action utilisateur. */
  startEnrollment(): Promise<void> {
    this.manualEnrollmentRequested = true;
    this.error = null;
    this.blockedUntilRetry = false;
    this.publish();
    return this.advance();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.teardown.forEach((fn) => { try { fn(); } catch { /* best effort */ } });
    this.teardown = [];
  }

  /** Une seule exécution du pipeline à la fois, quel que soit le nombre de vues. */
  private advance(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pipelinePromise) return this.pipelinePromise;
    const run = this.runPipeline().finally(() => {
      if (this.pipelinePromise === run) this.pipelinePromise = null;
    });
    this.pipelinePromise = run;
    return run;
  }

  private async runPipeline(): Promise<void> {
    if (!(await this.readServerState())) return;

    let previousAction: DeviceLifecycleStage | null = null;
    let repeats = 0;
    for (let step = 0; step < MAX_PIPELINE_STEPS; step += 1) {
      if (this.disposed || this.blockedUntilRetry) return;
      const action = this.nextAction();
      if (!action) return;
      repeats = action === previousAction ? repeats + 1 : 0;
      previousAction = action;
      if (repeats >= 2) {
        // Une étape qui réussit sans faire progresser l'état serveur est une
        // anomalie : erreur explicite + retry, jamais un spinner infini.
        this.error = `DEVICE_LIFECYCLE_STALLED:${action}`;
        this.blockedUntilRetry = true;
        this.stage = 'idle';
        this.publish();
        this.deps.log?.('pipeline-stalled', { userId: this.userId, action }, 'error');
        return;
      }
      if (!(await this.runStep(action))) return;
      if (!(await this.readServerState())) return;
    }
  }

  /** Détermine la SEULE prochaine transition légitime, dans l'ordre canonique. */
  private nextAction(): Exclude<DeviceLifecycleStage, 'idle' | 'reading'> | null {
    if (this.deviceIdStatus === 'mismatch' || this.deviceIdStatus === 'storage_unavailable') return null;
    const record = this.record;

    if (record === 'unknown') return null;
    if (!record || !this.deviceId) {
      // Aucun device serveur : Windows Web garde la récupération Windows Hello
      // prioritaire et n'enrôle jamais silencieusement un nouvel appareil.
      if (this.deps.isWindowsWeb() && !this.manualEnrollmentRequested) return null;
      return 'enrolling';
    }
    if (record.deviceId !== this.deviceId) return null;
    // Fail-closed : un appareil révoqué ou rejeté ne se répare jamais tout seul.
    if (record.approvalStatus === 'rejected') return null;
    if (record.revokedAt || record.bindingStatus === 'revoked') return null;
    if (record.approvalStatus === 'pending') return 'approving';
    if (record.approvalStatus !== 'approved') return null;
    if (record.isActive !== true) return null;
    if (record.lifecycleStatus === 'revoked') return null;
    // Ordre canonique strict : le PIN précède binding et préparation des clés.
    if (this.deps.pinRequired && !this.pinUnlocked) return null;
    if (record.bindingStatus !== 'bound') return 'binding';
    if (record.routingStatus !== 'ready') return 'preparing_keys';
    // Invariant : route prête ne vaut pas messagerie prête. La vraie sync des
    // clés de compte puis la finalisation serveur restent obligatoires, et le
    // drift `routing ready` / `lifecycle non ready` est repris ici même.
    if (this.accountSyncPhase !== 'ready' || record.lifecycleStatus !== 'ready') return 'syncing_account';
    return null;
  }

  private async runStep(action: Exclude<DeviceLifecycleStage, 'idle' | 'reading'>): Promise<boolean> {
    this.stage = action;
    this.error = null;
    this.publish();
    const startedAt = Date.now();
    this.deps.log?.('step-start', { userId: this.userId, action, deviceId: this.deviceId });

    try {
      const api = this.deps.api;
      if (action === 'syncing_account') {
        this.accountSyncPhase = 'syncing';
        this.publish();
      }
      if (action === 'syncing_account') {
        // Ordre canonique : vraie restauration/synchronisation des clés de
        // compte, PUIS seulement finalisation serveur du cycle de vie.
        await withStepTimeout(action, Promise.resolve(api.syncAccount(this.userId)), this.deps.stepTimeoutMs);
        await withStepTimeout(
          'finalizing',
          Promise.resolve(api.finalizeSynchronization(this.userId)),
          this.deps.stepTimeoutMs,
        );
      } else {
        const call = action === 'enrolling' ? api.enroll(this.userId)
          : action === 'approving' ? api.autoApprove(this.userId)
          : action === 'binding' ? api.bind(this.userId)
          : api.prepareKeys(this.userId);
        await withStepTimeout(action, Promise.resolve(call), this.deps.stepTimeoutMs);
      }
      if (action === 'enrolling') this.manualEnrollmentRequested = false;
      if (action === 'syncing_account') this.accountSyncPhase = 'ready';
      this.deps.log?.('step-success', { userId: this.userId, action, elapsedMs: Date.now() - startedAt });
      return true;
    } catch (cause) {
      // Aucune simulation de succès : l'UI doit afficher l'erreur et un retry.
      if (action === 'syncing_account') this.accountSyncPhase = 'failed';
      this.error = messageOf(cause);
      this.blockedUntilRetry = true;
      this.stage = 'idle';
      this.publish();
      this.deps.log?.('step-failed', {
        userId: this.userId, action, elapsedMs: Date.now() - startedAt, message: this.error,
      }, 'error');
      return false;
    }
  }

  /** Lecture serveur dédupliquée, avec timeout : jamais d'attente infinie. */
  private readServerState(): Promise<boolean> {
    if (this.readPromise) return this.readPromise.then(() => this.error === null);
    const run = this.doReadServerState().finally(() => {
      if (this.readPromise === run) this.readPromise = null;
    });
    this.readPromise = run;
    return run.then(() => this.error === null && !this.disposed);
  }

  private async doReadServerState(): Promise<void> {
    const previousStage = this.stage;
    this.stage = this.record === 'unknown' ? 'reading' : previousStage;

    try {
      await withStepTimeout('state_hydration', Promise.resolve(this.deps.hydrateDeviceId()), this.deps.stepTimeoutMs);
    } catch (cause) {
      // Un DeviceID absent est un état normal (nouvel appareil), pas une erreur.
      this.deps.log?.('hydrate-device-id-failed', { message: messageOf(cause) }, 'warn');
    }
    if (this.disposed) return;

    this.deviceIdStatus = this.deps.getDeviceIdStatus();
    this.deviceId = this.deps.peekDeviceId();

    if (!this.deviceId || this.deviceIdStatus !== 'ok') {
      this.setRecord(null);
      this.stage = 'idle';
      this.publish();
      return;
    }

    try {
      const snapshot = await withStepTimeout(
        'state_lookup',
        Promise.resolve(this.deps.api.getState(this.userId)),
        this.deps.stepTimeoutMs,
      );
      if (this.disposed) return;
      const row = snapshot.record;
      this.setRecord(row ? {
        deviceId: row.deviceId,
        approvalStatus: row.approvalStatus,
        bindingStatus: row.bindingStatus,
        routingStatus: row.routingStatus,
        lifecycleStatus: normalizeLifecycleStatus(row.lifecycleStatus),
        isActive: row.isActive,
        revokedAt: row.revokedAt,
      } : null);
      this.stage = 'idle';
      this.error = null;
      this.publish();
    } catch (cause) {
      // Sans cette branche l'écran « Vérification de cet appareil » tournait
      // indéfiniment quand la lecture serveur échouait.
      this.error = `DEVICE_STATE_LOOKUP_FAILED:${messageOf(cause)}`;
      this.blockedUntilRetry = true;
      this.stage = 'idle';
      if (this.record === 'unknown') this.setRecord(null);
      this.publish();
      this.deps.log?.('server-device-state-failed', { message: this.error }, 'error');
    }
  }

  private setRecord(next: DeviceLifecycleRecord | null): void {
    const signature = recordKey(next);
    if (this.recordSignature === signature) return;
    this.recordSignature = signature;
    this.record = next;
  }

  private computeSnapshot(): DeviceLifecycleSnapshot {
    const { state, reason } = resolveDeviceLifecycleState({
      authenticated: true,
      deviceRecord: this.record,
      deviceIdStatus: this.deviceIdStatus,
      pinUnlocked: this.pinUnlocked,
      pinRequired: this.deps.pinRequired,
      accountSyncPhase: this.accountSyncPhase,
    });

    return {
      state,
      reason,
      deviceId: this.deviceId,
      deviceIdStatus: this.deviceIdStatus,
      record: this.record === 'unknown' ? null : this.record,
      loading: this.record === 'unknown' && this.error === null,
      stage: this.stage,
      error: this.error,
      pinUnlocked: this.deps.pinRequired ? this.pinUnlocked : true,
      accountSyncPhase: this.accountSyncPhase,
      canPromptForPin: canPromptForPin(state),
      canRunDeviceKeySetup: canRunDeviceKeySetup(state),
      canRunCryptoRuntime: canRunCryptoRuntime(state),
      needsApprovalUi: requiresDeviceApprovalUi(state),
      canStartEnrollment: this.record !== 'unknown' && this.record === null && this.stage === 'idle',
    };
  }

  private publish(): void {
    if (this.disposed) return;
    this.snapshot = this.computeSnapshot();
    this.listeners.forEach((listener) => listener(this.snapshot));
  }
}

const controllers = new Map<string, DeviceLifecycleController>();
let depsFactory: ((userId: string) => DeviceLifecycleDeps) | null = null;

export function configureDeviceLifecycleDeps(factory: (userId: string) => DeviceLifecycleDeps): void {
  depsFactory = factory;
}

export function getDeviceLifecycleController(userId: string): DeviceLifecycleController {
  const existing = controllers.get(userId);
  if (existing) return existing;
  if (!depsFactory) throw new Error('DEVICE_LIFECYCLE_DEPS_NOT_CONFIGURED');
  const created = new DeviceLifecycleController(userId, depsFactory(userId));
  controllers.set(userId, created);
  // Un seul contrôleur vivant : changer de compte détruit les précédents.
  controllers.forEach((controller, key) => {
    if (key !== userId) {
      controller.dispose();
      controllers.delete(key);
    }
  });
  return created;
}

export function resetDeviceLifecycleControllers(): void {
  controllers.forEach((controller) => controller.dispose());
  controllers.clear();
}

export const __deviceLifecycleTestUtils = {
  create(userId: string, deps: Partial<DeviceLifecycleDeps> & { api: DeviceLifecycleApi }): DeviceLifecycleController {
    return new DeviceLifecycleController(userId, {
      hydrateDeviceId: async () => undefined,
      getDeviceIdStatus: () => 'ok',
      peekDeviceId: () => 'dev_00000000000000000000000000000000',
      setUserScope: () => undefined,
      isWindowsWeb: () => false,
      readPinUnlocked: () => true,
      subscribePinUnlocked: () => () => undefined,
      onDeviceRecordChanged: () => () => undefined,
      pinRequired: false,
      stepTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      ...deps,
    });
  },
  DEFAULT_STEP_TIMEOUT_MS,
};
