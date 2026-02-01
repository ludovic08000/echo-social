import { useMemo } from 'react';
import { sanitizeUrl, urlSchema, optionalUrlSchema } from '@/lib/urlUtils';

export function useUrlValidation() {
  return useMemo(
    () => ({
      validateUrl: (url: string): { valid: boolean; error?: string } => {
        const result = urlSchema.safeParse(url);
        if (result.success) {
          return { valid: true };
        }
        return { valid: false, error: result.error.errors[0]?.message || 'URL invalide' };
      },

      validateOptionalUrl: (url?: string): { valid: boolean; error?: string } => {
        if (!url || url.trim() === '') {
          return { valid: true };
        }
        const result = optionalUrlSchema.safeParse(url);
        if (result.success) {
          return { valid: true };
        }
        return { valid: false, error: result.error.errors[0]?.message || 'URL invalide' };
      },

      sanitizeUrl: (url: string): string | null => {
        return sanitizeUrl(url);
      },

      isValidUrl: (url: string): boolean => {
        return urlSchema.safeParse(url).success;
      },

      isValidUUID: (id: string): boolean => {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidRegex.test(id);
      },
    }),
    []
  );
}
