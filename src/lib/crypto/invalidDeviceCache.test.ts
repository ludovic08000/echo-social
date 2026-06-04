import { describe, expect, it } from 'vitest';
import { isInvalidDeviceId } from './invalidDeviceCache';

describe('invalidDeviceCache', () => {
  it('contains known bad devices', () => {
    expect(isInvalidDeviceId('6508eb47a200893f49720fe84b9290b3')).toBe(true);
    expect(isInvalidDeviceId('9da8c742a4fe81d1d9ce6c0ffb4e055b')).toBe(true);
  });

  it('rehabilitated devices are not blocked', () => {
    expect(isInvalidDeviceId('84aaa52143235807214bf3aa161dd03a')).toBe(false);
  });
});
