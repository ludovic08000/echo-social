export function resolveApplicationVariant(value: unknown): 'social' | 'messenger' {
  return value === 'messenger' ? 'messenger' : 'social';
}

// Choix de compilation uniquement : ne modifie ni compte, ni clés, ni approbation.
export const IS_MESSENGER_APP = resolveApplicationVariant(import.meta.env.VITE_APP_VARIANT) === 'messenger';
export const APPLICATION_HOME = IS_MESSENGER_APP ? '/messages' : '/feed';
