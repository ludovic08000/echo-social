from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"missing anchor: {label}")
    return text.replace(old, new, 1)


identity_path = Path('src/lib/crypto/deviceIdentity.ts')
identity = identity_path.read_text(encoding='utf-8')
identity = replace_once(
    identity,
    """function dbPut<T>(value: T): Promise<void> {
  return runTx([STORE_KEYS], 'readwrite', (tx) => {
    tx.objectStore(STORE_KEYS).put(value as unknown as object);
  });
}
""",
    """function dbPut<T>(value: T): Promise<void> {
  return runTx([STORE_KEYS], 'readwrite', (tx) => {
    tx.objectStore(STORE_KEYS).put(value as unknown as object);
  });
}

function dbDelete(key: string): Promise<void> {
  return runTx([STORE_KEYS], 'readwrite', (tx) => {
    tx.objectStore(STORE_KEYS).delete(key);
  });
}
""",
    'device identity dbDelete',
)
identity = replace_once(
    identity,
    """export async function signDeviceAuthorization(args: {
""",
    """/** Remove a provisional signing identity after confirmed server cancellation. */
export async function deleteDeviceIdentity(userId: string, deviceId: string): Promise<void> {
  creationJobs.delete(storageKey(userId, deviceId));
  try {
    await dbDelete(storageKey(userId, deviceId));
  } catch {
    // Failure cleanup is best-effort; never rotate an established device here.
  }
}

export async function signDeviceAuthorization(args: {
""",
    'deleteDeviceIdentity export',
)
identity_path.write_text(identity, encoding='utf-8')

server_path = Path('src/lib/crypto/serverDeviceEnrollment.ts')
server = server_path.read_text(encoding='utf-8')
settlement_types = """
export type DeviceEnrollmentSettlement = {
  status: 'completed' | 'cancelled';
  deviceId: string;
};
"""
server = replace_once(
    server,
    """export interface DeviceEnrollmentChallenge {
  challengeId: string;
  deviceId: string;
  nonce: string;
  expiresAt: string;
}
""",
    """export interface DeviceEnrollmentChallenge {
  challengeId: string;
  deviceId: string;
  nonce: string;
  expiresAt: string;
}
""" + settlement_types,
    'settlement type',
)

parse_settlement = """
export function parseDeviceEnrollmentSettlement(
  value: unknown,
  expectedDeviceId: string,
): DeviceEnrollmentSettlement {
  const result = asObject(value);
  if (result.ok !== true) throw new Error(responseCode(result));

  const deviceId = typeof result.device_id === 'string' ? result.device_id : '';
  if (!SERVER_DEVICE_ID_RE.test(deviceId)) {
    throw new Error('DEVICE_ENROLLMENT_INVALID_DEVICE_ID');
  }
  if (deviceId !== expectedDeviceId) {
    throw new Error('DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
  }

  const code = responseCode(result);
  if (code === 'DEVICE_ENROLLMENT_ALREADY_COMPLETED') {
    return { status: 'completed', deviceId };
  }
  if (code === 'DEVICE_ENROLLMENT_CANCELLED' || code === 'DEVICE_ENROLLMENT_ALREADY_CANCELLED') {
    return { status: 'cancelled', deviceId };
  }
  throw new Error('DEVICE_ENROLLMENT_INVALID_SETTLEMENT');
}
"""
server = replace_once(
    server,
    """export async function hasRegisteredDevice(
""",
    parse_settlement + "\nexport async function hasRegisteredDevice(\n",
    'settlement parser',
)

cancel_function = """

export async function cancelServerAssignedDeviceEnrollment(
  challenge: DeviceEnrollmentChallenge,
  reason: string,
): Promise<DeviceEnrollmentSettlement> {
  const { data, error } = await supabase.rpc(
    'cancel_user_device_enrollment' as never,
    {
      p_challenge_id: challenge.challengeId,
      p_nonce: challenge.nonce,
      p_reason: reason.slice(0, 120),
    } as never,
  );

  if (error) throw new Error(`DEVICE_ENROLLMENT_CANCEL_FAILED:${error.message}`);
  return parseDeviceEnrollmentSettlement(data, challenge.deviceId);
}
"""
if 'cancelServerAssignedDeviceEnrollment' not in server:
    server = server.rstrip() + cancel_function + "\n"
server_path.write_text(server, encoding='utf-8')

resync_path = Path('src/lib/crypto/resyncE2EE.ts')
resync = resync_path.read_text(encoding='utf-8')
resync = replace_once(
    resync,
    "import { getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';",
    "import { deleteDeviceKxKey, getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';",
    'deleteDeviceKxKey import',
)
resync = replace_once(
    resync,
    "import { prepareDeviceAuthorization } from '@/lib/crypto/deviceIdentity';",
    "import { deleteDeviceIdentity, prepareDeviceAuthorization } from '@/lib/crypto/deviceIdentity';",
    'deleteDeviceIdentity import',
)
resync = replace_once(
    resync,
    """  beginServerAssignedDeviceEnrollment,
  completeServerAssignedDeviceEnrollment,
  hasRegisteredDevice,
""",
    """  beginServerAssignedDeviceEnrollment,
  cancelServerAssignedDeviceEnrollment,
  completeServerAssignedDeviceEnrollment,
  hasRegisteredDevice,
""",
    'cancel enrollment import',
)

old_complete = """    if (enrollmentChallenge) {
      const completedDeviceId = await completeServerAssignedDeviceEnrollment(
        enrollmentChallenge,
        authorization,
      );
      if (completedDeviceId !== deviceId) {
        throw new Error('DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
      }
      // Commit the routing identity only after the server transaction succeeds.
      setCurrentDeviceId(completedDeviceId);
      result.deviceId = completedDeviceId;
      result.identity = true;
      diag?.push('identity', 'success', 'server device enrollment completed', {
        deviceIdLength: completedDeviceId.length,
      });
    } else {
"""
new_complete = """    if (enrollmentChallenge) {
      try {
        const completedDeviceId = await completeServerAssignedDeviceEnrollment(
          enrollmentChallenge,
          authorization,
        );
        if (completedDeviceId !== deviceId) {
          throw new Error('DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
        }
        // Commit the routing identity only after the server transaction succeeds.
        setCurrentDeviceId(completedDeviceId);
        result.deviceId = completedDeviceId;
        result.identity = true;
        diag?.push('identity', 'success', 'server device enrollment completed', {
          deviceIdLength: completedDeviceId.length,
        });
      } catch (completionError) {
        const settlement = await cancelServerAssignedDeviceEnrollment(
          enrollmentChallenge,
          'completion_failed',
        ).catch(() => null);

        if (settlement?.status === 'completed') {
          // The commit succeeded but its HTTP response was lost. Keep the keys.
          setCurrentDeviceId(settlement.deviceId);
          result.deviceId = settlement.deviceId;
          result.identity = true;
          diag?.push('identity', 'success', 'recovered committed device after ambiguous response', {
            deviceIdLength: settlement.deviceId.length,
          });
        } else {
          if (settlement?.status === 'cancelled') {
            await Promise.allSettled([
              deleteDeviceKxKey(deviceId, userId),
              deleteDeviceIdentity(userId, deviceId),
            ]);
            diag?.push('identity', 'info', 'removed provisional device keys after cancellation');
          } else {
            diag?.push('identity', 'warn', 'enrollment settlement unavailable; provisional keys retained');
          }
          throw completionError;
        }
      }
    } else {
"""
resync = replace_once(resync, old_complete, new_complete, 'ambiguous completion settlement')
resync_path.write_text(resync, encoding='utf-8')

test_path = Path('src/lib/crypto/__tests__/serverDeviceEnrollment.test.ts')
test = test_path.read_text(encoding='utf-8')
test = replace_once(
    test,
    """  parseCompletedDeviceEnrollment,
  parseDeviceEnrollmentChallenge,
""",
    """  parseCompletedDeviceEnrollment,
  parseDeviceEnrollmentChallenge,
  parseDeviceEnrollmentSettlement,
""",
    'settlement test import',
)
extra_tests = """

  it('recovers a server commit after an ambiguous HTTP response', () => {
    expect(parseDeviceEnrollmentSettlement({
      ok: true,
      code: 'DEVICE_ENROLLMENT_ALREADY_COMPLETED',
      device_id: DEVICE_ID,
    }, DEVICE_ID)).toEqual({ status: 'completed', deviceId: DEVICE_ID });
  });

  it('confirms cancellation before provisional keys may be deleted', () => {
    expect(parseDeviceEnrollmentSettlement({
      ok: true,
      code: 'DEVICE_ENROLLMENT_CANCELLED',
      device_id: DEVICE_ID,
    }, DEVICE_ID)).toEqual({ status: 'cancelled', deviceId: DEVICE_ID });

    expect(() => parseDeviceEnrollmentSettlement({
      ok: false,
      code: 'DEVICE_ENROLLMENT_INVALID_NONCE',
    }, DEVICE_ID)).toThrow('DEVICE_ENROLLMENT_INVALID_NONCE');
  });
"""
if "recovers a server commit after an ambiguous HTTP response" not in test:
    closing = test.rfind('\n});')
    if closing < 0:
        raise RuntimeError('test suite closing anchor missing')
    test = test[:closing] + extra_tests + test[closing:]
test_path.write_text(test, encoding='utf-8')

print('stage 3 enrollment settlement patch applied')
