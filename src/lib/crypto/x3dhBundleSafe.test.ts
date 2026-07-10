import { describe, expect, it } from 'vitest';
import {
  DeviceX3DHRouteRequiredError,
  fetchPrekeyBundle,
} from './x3dhBundleSafe';

describe('x3dhBundleSafe', () => {
  it('never returns the retired account-wide X3DH bundle', async () => {
    await expect(fetchPrekeyBundle('peer-user-id')).rejects.toBeInstanceOf(
      DeviceX3DHRouteRequiredError,
    );
  });
});
