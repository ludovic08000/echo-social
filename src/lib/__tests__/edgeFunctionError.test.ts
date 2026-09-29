import { describe, expect, it } from 'vitest';
import { edgeFunctionErrorMessage } from '../edgeFunctionError';

describe('edgeFunctionErrorMessage', () => {
  it('surfaces the safe JSON error returned by an edge function', async () => {
    const error = {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: {
        clone: () => ({
          json: async () => ({ error: 'Crédits IA insuffisants.' }),
        }),
      },
    };

    await expect(edgeFunctionErrorMessage(error)).resolves.toBe('Crédits IA insuffisants.');
  });

  it('turns transport failures into an actionable message', async () => {
    await expect(edgeFunctionErrorMessage({ name: 'FunctionsFetchError' }))
      .resolves.toBe('Connexion au service IA impossible. Réessayez.');
  });

  it('does not expose the generic Supabase HTTP wrapper', async () => {
    await expect(edgeFunctionErrorMessage({
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
    })).resolves.toBe('Erreur IA');
  });
});
