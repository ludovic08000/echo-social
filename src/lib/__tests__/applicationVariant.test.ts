import { describe, expect, it } from 'vitest';
import { resolveApplicationVariant } from '../applicationVariant';

describe('application packaging isolation', () => {
  it('keeps the existing social app as default', () => {
    for (const value of [undefined, null, '', 'social', 'unknown']) expect(resolveApplicationVariant(value)).toBe('social');
  });
  it('selects messaging only through an explicit build setting', () => {
    expect(resolveApplicationVariant('messenger')).toBe('messenger');
    expect(resolveApplicationVariant('MESSENGER')).toBe('social');
  });
});
