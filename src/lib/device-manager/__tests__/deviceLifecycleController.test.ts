import { describe, expect, it, vi } from 'vitest';
import {
  __deviceLifecycleTestUtils,
  type DeviceLifecycleApi,
} from '../deviceLifecycleController';

const DEVICE_ID = 'dev_00000000000000000000000000000000';
const OTHER_DEVICE_ID = 'dev_11111111111111111111111111111111';

type Row = {
  deviceId: string;
  approvalStatus: 'pending' | 'approved' | 'rejected' | null;
  bindingStatus: 'pending' | 'bound' | 'revoked' | null;
  routingStatus: 'repairing' | 'ready' | 'unavailable' | null;
  lifecycleStatus: 'pending' | 'approved' | 'syncing' | 'ready' | 'revoked' | null;
  isActive: boolean | null;
  revokedAt: string | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    deviceId: DEVICE_ID,
    approvalStatus: 'pending',
    bindingStatus: 'pending',
    routingStatus: 'unavailable',
    lifecycleStatus: 'pending',
    isActive: true,
    revokedAt: null,
    ...overrides,
  };
}

/** Serveur factice : seules les RPC réussies font avancer l'état. */
function fakeServer(initial: Row | null) {
  const state: { record: Row | null } = { record: initial };
  const calls = {
    getState: 0, enroll: 0, autoApprove: 0, bind: 0,
    prepareKeys: 0, syncAccount: 0, finalize: 0,
  };
  let accountSynced = false;
  const api: DeviceLifecycleApi = {
    getState: async () => { calls.getState += 1; return { record: state.record }; },
    enroll: async () => {
      calls.enroll += 1;
      state.record = row();
    },
    autoApprove: async () => {
      calls.autoApprove += 1;
      if (state.record?.approvalStatus !== 'pending') throw new Error('DEVICE_AUTO_APPROVAL_NOT_PENDING');
      state.record = { ...state.record, approvalStatus: 'approved', lifecycleStatus: 'approved' };
    },
    bind: async () => {
      calls.bind += 1;
      if (state.record?.approvalStatus !== 'approved') throw new Error('DEVICE_NOT_APPROVED');
      state.record = { ...state.record, bindingStatus: 'bound' };
    },
    prepareKeys: async () => {
      calls.prepareKeys += 1;
      if (state.record?.bindingStatus !== 'bound') throw new Error('DEVICE_NOT_READY_FOR_KEYS');
      // Reproduit le serveur : mark_current_device_route_ready uniquement.
      state.record = { ...state.record, routingStatus: 'ready' };
    },
    syncAccount: async () => { calls.syncAccount += 1; accountSynced = true; },
    finalizeSynchronization: async () => {
      calls.finalize += 1;
      if (!accountSynced) throw new Error('ACCOUNT_SYNC_REQUIRED_BEFORE_FINALIZATION');
      if (state.record?.routingStatus !== 'ready') throw new Error('DEVICE_ROUTE_NOT_READY');
      state.record = { ...state.record, lifecycleStatus: 'ready' };
    },
  };
  return { api, calls, state, markAccountSynced: () => { accountSynced = true; } };
}

describe('deviceLifecycleController — flux canonique unique', () => {
  it('enrôle, approuve, lie puis prépare les clés d’un nouvel appareil', async () => {
    const server = fakeServer(null);
    const order: string[] = [];
    const controller = __deviceLifecycleTestUtils.create('user-1', {
      api: server.api,
      log: (stage, details) => { if (stage === 'step-start') order.push(String(details.action)); },
    });
    await controller.refresh();

    expect(order).toEqual(['enrolling', 'approving', 'binding', 'preparing_keys', 'syncing_account']);
    expect(controller.getSnapshot().state).toBe('MESSAGING_READY');
    expect(controller.getSnapshot().error).toBeNull();
    controller.dispose();
  });

  it('reprend un appareil déjà pending sans le ré-enrôler', async () => {
    const server = fakeServer(row());
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    await controller.refresh();

    expect(server.calls.enroll).toBe(0);
    expect(server.calls.autoApprove).toBe(1);
    expect(controller.getSnapshot().state).toBe('MESSAGING_READY');
    controller.dispose();
  });

  it('refuse un utilisateur non authentifié sans boucler', async () => {
    const server = fakeServer(row());
    server.api.autoApprove = async () => { throw new Error('NOT_AUTHENTICATED'); };
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    await controller.refresh();

    expect(controller.getSnapshot().error).toBe('NOT_AUTHENTICATED');
    expect(controller.getSnapshot().canRunCryptoRuntime).toBe(false);
    controller.dispose();
  });

  it('ne pilote jamais le device d’un autre compte', async () => {
    const server = fakeServer(row({ deviceId: OTHER_DEVICE_ID, approvalStatus: 'approved', bindingStatus: 'pending' }));
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    await controller.refresh();

    expect(server.calls.bind).toBe(0);
    expect(server.calls.prepareKeys).toBe(0);
    controller.dispose();
  });

  it('déduplique les montages concurrents (StrictMode / plusieurs écrans)', async () => {
    const server = fakeServer(null);
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    await Promise.all([
      controller.refresh(), controller.refresh(), controller.refresh(),
      controller.refresh(), controller.refresh(),
    ]);

    expect(server.calls.enroll).toBe(1);
    expect(server.calls.autoApprove).toBe(1);
    expect(server.calls.bind).toBe(1);
    expect(server.calls.prepareKeys).toBe(1);
    controller.dispose();
  });

  it('supporte une RPC lente puis réussie sans doubler l’appel', async () => {
    const server = fakeServer(row({ approvalStatus: 'approved', bindingStatus: 'pending' }));
    const slowBind = server.api.bind;
    server.api.bind = async (userId) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return slowBind(userId);
    };
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    const first = controller.refresh();
    const second = controller.refresh();
    await Promise.all([first, second]);

    expect(server.calls.bind).toBe(1);
    expect(controller.getSnapshot().state).toBe('MESSAGING_READY');
    controller.dispose();
  });

  it('expose une erreur et un retry au lieu d’une attente infinie', async () => {
    const server = fakeServer(row({ approvalStatus: 'approved', bindingStatus: 'bound' }));
    let failures = 1;
    const realPrepare = server.api.prepareKeys;
    server.api.prepareKeys = async (userId) => {
      if (failures-- > 0) throw new Error('DEVICE_ROUTE_NOT_READY:DEVICE_ROUTE_INCOMPLETE');
      return realPrepare(userId);
    };
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    await controller.refresh();

    expect(controller.getSnapshot().error).toBe('DEVICE_ROUTE_NOT_READY:DEVICE_ROUTE_INCOMPLETE');
    expect(controller.getSnapshot().loading).toBe(false);
    expect(controller.getSnapshot().stage).toBe('idle');

    await controller.retry();
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().state).toBe('MESSAGING_READY');
    controller.dispose();
  });

  it('n’attend jamais indéfiniment une RPC bloquée', async () => {
    const server = fakeServer(row({ approvalStatus: 'approved', bindingStatus: 'bound' }));
    server.api.prepareKeys = () => new Promise(() => undefined);
    const controller = __deviceLifecycleTestUtils.create('user-1', {
      api: server.api,
      stepTimeoutMs: 20,
    });
    await controller.refresh();

    expect(controller.getSnapshot().error).toBe('DEVICE_PREPARING_KEYS_TIMEOUT');
    controller.dispose();
  });

  it('surface une lecture serveur en échec au lieu de rester en chargement', async () => {
    const server = fakeServer(row());
    server.api.getState = async () => { throw new Error('NETWORK_DOWN'); };
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    await controller.refresh();

    const snapshot = controller.getSnapshot();
    expect(snapshot.loading).toBe(false);
    expect(snapshot.error).toContain('DEVICE_STATE_LOOKUP_FAILED');
    controller.dispose();
  });

  it('respecte le PIN actif et le PIN désactivé', async () => {
    const locked = fakeServer(row({ approvalStatus: 'approved', bindingStatus: 'pending' }));
    const lockedController = __deviceLifecycleTestUtils.create('user-1', {
      api: locked.api,
      pinRequired: true,
      readPinUnlocked: () => false,
    });
    await lockedController.refresh();
    expect(locked.calls.bind).toBe(0);
    expect(lockedController.getSnapshot().state).toBe('APPROVED_LOCKED');
    lockedController.dispose();

    const open = fakeServer(row({ approvalStatus: 'approved', bindingStatus: 'pending' }));
    const openController = __deviceLifecycleTestUtils.create('user-1', {
      api: open.api,
      pinRequired: true,
      readPinUnlocked: () => true,
    });
    await openController.refresh();
    expect(open.calls.bind).toBe(1);
    expect(openController.getSnapshot().state).toBe('MESSAGING_READY');
    openController.dispose();
  });

  it('est idempotent quand le provisioning et la synchronisation sont valides', async () => {
    const server = fakeServer(row({
      approvalStatus: 'approved', bindingStatus: 'bound', routingStatus: 'ready', lifecycleStatus: 'ready',
    }));
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    await controller.refresh();
    await controller.refresh();

    expect(server.calls.prepareKeys).toBe(0);
    expect(server.calls.syncAccount).toBe(1);
    expect(controller.getSnapshot().state).toBe('MESSAGING_READY');
    controller.dispose();
  });

  it('reprend la finalisation quand la route est prête mais lifecycle_status ne l’est pas', async () => {
    const server = fakeServer(row({
      approvalStatus: 'approved', bindingStatus: 'bound', routingStatus: 'ready', lifecycleStatus: 'syncing',
    }));
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    await controller.refresh();

    expect(server.calls.prepareKeys).toBe(1);
    expect(controller.getSnapshot().state).toBe('MESSAGING_READY');
    controller.dispose();
  });

  it('n’ouvre jamais la messagerie si la synchronisation de compte échoue', async () => {
    const server = fakeServer(row({
      approvalStatus: 'approved', bindingStatus: 'bound', routingStatus: 'ready', lifecycleStatus: 'ready',
    }));
    server.api.syncAccount = async () => { throw new Error('ACCOUNT_SYNC_FAILED'); };
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    await controller.refresh();

    const snapshot = controller.getSnapshot();
    expect(snapshot.canRunCryptoRuntime).toBe(false);
    expect(snapshot.accountSyncPhase).toBe('failed');
    expect(snapshot.error).toBe('ACCOUNT_SYNC_FAILED');
    controller.dispose();
  });

  it('n’ouvre jamais la messagerie sans PIN déverrouillé', async () => {
    const server = fakeServer(row({
      approvalStatus: 'approved', bindingStatus: 'bound', routingStatus: 'ready', lifecycleStatus: 'ready',
    }));
    const controller = __deviceLifecycleTestUtils.create('user-1', {
      api: server.api,
      pinRequired: true,
      readPinUnlocked: () => false,
    });
    await controller.refresh();

    expect(controller.getSnapshot().state).toBe('APPROVED_LOCKED');
    expect(controller.getSnapshot().canRunCryptoRuntime).toBe(false);
    expect(server.calls.syncAccount).toBe(0);
    controller.dispose();
  });

  it('reste fail-closed sur un appareil révoqué ou rejeté', async () => {
    const revoked = fakeServer(row({ approvalStatus: 'approved', revokedAt: new Date().toISOString() }));
    const revokedController = __deviceLifecycleTestUtils.create('user-1', { api: revoked.api });
    await revokedController.refresh();
    expect(revoked.calls.bind).toBe(0);
    expect(revokedController.getSnapshot().state).toBe('LINK_REQUIRED');
    expect(revokedController.getSnapshot().canRunCryptoRuntime).toBe(false);
    revokedController.dispose();

    const rejected = fakeServer(row({ approvalStatus: 'rejected' }));
    const rejectedController = __deviceLifecycleTestUtils.create('user-1', { api: rejected.api });
    await rejectedController.refresh();
    expect(rejected.calls.autoApprove).toBe(0);
    expect(rejectedController.getSnapshot().state).toBe('LINK_REQUIRED');
    rejectedController.dispose();
  });

  it('n’enrôle jamais silencieusement sur Windows Web sans action utilisateur', async () => {
    const server = fakeServer(null);
    const controller = __deviceLifecycleTestUtils.create('user-1', {
      api: server.api,
      isWindowsWeb: () => true,
    });
    await controller.refresh();
    expect(server.calls.enroll).toBe(0);
    expect(controller.getSnapshot().canStartEnrollment).toBe(true);

    await controller.startEnrollment();
    expect(server.calls.enroll).toBe(1);
    expect(controller.getSnapshot().state).toBe('MESSAGING_READY');
    controller.dispose();
  });

  it('n’enrôle pas quand le stockage du DeviceID est incohérent', async () => {
    const server = fakeServer(null);
    const controller = __deviceLifecycleTestUtils.create('user-1', {
      api: server.api,
      getDeviceIdStatus: () => 'mismatch',
      peekDeviceId: () => null,
    });
    await controller.refresh();

    expect(server.calls.enroll).toBe(0);
    expect(controller.getSnapshot().state).toBe('LINK_REQUIRED');
    controller.dispose();
  });

  it('notifie les abonnés à chaque changement d’état observable', async () => {
    const server = fakeServer(null);
    const listener = vi.fn();
    const controller = __deviceLifecycleTestUtils.create('user-1', { api: server.api });
    controller.subscribe(listener);
    await controller.refresh();

    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls.at(-1)?.[0].state).toBe('MESSAGING_READY');
    controller.dispose();
  });
});


describe('barrière de synchronisation des clés de compte', () => {
  it('ne finalise jamais le serveur avant la vraie synchronisation', async () => {
    const server = fakeServer(null);
    const order: string[] = [];
    const controller = __deviceLifecycleTestUtils.create('user-sync', {
      api: {
        ...server.api,
        syncAccount: async (id) => { order.push('sync'); await server.api.syncAccount(id); },
        finalizeSynchronization: async (id) => {
          order.push('finalize');
          await server.api.finalizeSynchronization(id);
        },
      },
    });
    await controller.refresh();

    expect(order).toEqual(['sync', 'finalize']);
    expect(server.state.record?.lifecycleStatus).toBe('ready');
    expect(controller.getSnapshot().state).toBe('MESSAGING_READY');
    controller.dispose();
  });

  it('bloque la messagerie et expose un retry si la restauration est requise', async () => {
    const server = fakeServer(null);
    let failing = true;
    const controller = __deviceLifecycleTestUtils.create('user-restore', {
      api: {
        ...server.api,
        syncAccount: async (id) => {
          if (failing) throw new Error('ACCOUNT_KEY_RESTORE_REQUIRED:cold_start_sentinel');
          await server.api.syncAccount(id);
        },
      },
    });
    await controller.refresh();

    let snapshot = controller.getSnapshot();
    expect(snapshot.accountSyncPhase).toBe('failed');
    expect(snapshot.canRunCryptoRuntime).toBe(false);
    expect(snapshot.state).toBe('ACCOUNT_KEY_SYNC');
    expect(snapshot.error).toContain('ACCOUNT_KEY_RESTORE_REQUIRED');
    expect(server.calls.finalize).toBe(0);

    failing = false;
    await controller.retry();
    snapshot = controller.getSnapshot();
    expect(snapshot.state).toBe('MESSAGING_READY');
    expect(snapshot.canRunCryptoRuntime).toBe(true);
    controller.dispose();
  });

  it('reprend le drift route prête / lifecycle non prêt', async () => {
    const server = fakeServer(row({
      approvalStatus: 'approved',
      bindingStatus: 'bound',
      routingStatus: 'ready',
      lifecycleStatus: 'syncing',
    }));
    const controller = __deviceLifecycleTestUtils.create('user-drift', { api: server.api });
    await controller.refresh();

    expect(server.calls.prepareKeys).toBe(0);
    expect(server.calls.syncAccount).toBe(1);
    expect(server.calls.finalize).toBe(1);
    expect(server.state.record?.lifecycleStatus).toBe('ready');
    expect(controller.getSnapshot().state).toBe('MESSAGING_READY');
    controller.dispose();
  });

  it('déduplique les appels concurrents à la synchronisation', async () => {
    const server = fakeServer(null);
    const controller = __deviceLifecycleTestUtils.create('user-concurrent', { api: server.api });
    await Promise.all([controller.refresh(), controller.refresh(), controller.refresh()]);

    expect(server.calls.syncAccount).toBe(1);
    expect(server.calls.finalize).toBe(1);
    controller.dispose();
  });
});
