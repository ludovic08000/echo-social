import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useUrlValidation } from '../useUrlValidation';

it('preserves URL validation and useful errors after the validator security update', () => {
  const { result } = renderHook(() => useUrlValidation());
  expect(result.current.validateUrl('https://forsure.fans/feed')).toEqual({ valid: true });
  expect(result.current.validateUrl('not-a-url')).toEqual({ valid: false, error: 'URL invalide' });
  expect(result.current.validateUrl('javascript:alert(1)').valid).toBe(false);
  expect(result.current.validateOptionalUrl()).toEqual({ valid: true });
  expect(result.current.validateOptionalUrl('  ')).toEqual({ valid: true });
  expect(result.current.validateOptionalUrl('not-a-url')).toEqual({ valid: false, error: 'URL invalide' });
  expect(result.current.validateOptionalUrl('https://example.com')).toEqual({ valid: true });
  expect(result.current.sanitizeUrl('javascript:alert(1)')).toBeNull();
});
