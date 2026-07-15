import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDeviceOperationStateForTests,
  runDeviceOperation,
} from '@/lib/device-manager/operationLock';

describe('device operation coordinator', () => {
  beforeEach(() => clearDeviceOperationStateForTests());

  it('coalesces concurrent resync callers onto one operation', async () => {
    let resolveOperation!: (value: string) => void;
    const operation = vi.fn(() => new Promise<string>((resolve) => {
      resolveOperation = resolve;
    }));

    const first = runDeviceOperation('resync:user', operation);
    const second = runDeviceOperation('resync:user', operation);

    expect(operation).toHaveBeenCalledOnce();
    resolveOperation('done');
    await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done']);
  });

  it('allows different devices to run independently', async () => {
    const first = vi.fn(async () => 'device-a');
    const second = vi.fn(async () => 'device-b');

    await expect(Promise.all([
      runDeviceOperation('prekey:a', first),
      runDeviceOperation('prekey:b', second),
    ])).resolves.toEqual(['device-a', 'device-b']);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
