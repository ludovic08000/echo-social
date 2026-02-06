import type { MessagingProvider } from './types';

/**
 * Messaging Provider Registry
 * 
 * Currently uses the built-in Supabase messaging.
 * To switch to an external provider:
 * 
 * 1. Create a class implementing MessagingProvider (see types.ts)
 * 2. Register it: setMessagingProvider(new MyProvider())
 * 3. The hooks in useMessages.ts can then be updated to use this provider
 * 
 * Example:
 * ```ts
 * import { TwilioProvider } from './providers/twilio';
 * import { setMessagingProvider } from './provider';
 * 
 * setMessagingProvider(new TwilioProvider());
 * ```
 */

let currentProvider: MessagingProvider | null = null;

export function setMessagingProvider(provider: MessagingProvider): void {
  currentProvider = provider;
  console.log(`[Messaging] Provider set: ${provider.name}`);
}

export function getMessagingProvider(): MessagingProvider | null {
  return currentProvider;
}

export function hasExternalProvider(): boolean {
  return currentProvider !== null;
}
