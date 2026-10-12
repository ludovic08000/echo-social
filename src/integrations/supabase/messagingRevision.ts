// Contrat API du pilote, indépendant du format des clés et du chiffrement.
export const MESSAGING_CLIENT_REVISION = '1';

/** Limité à REST sur notre backend : aucun en-tête ajouté à Auth, aux Edge
 * Functions ou à un service externe (leurs règles CORS restent inchangées). */
export function withMessagingRevision(input: RequestInfo | URL, init: RequestInit | undefined,
  backendUrl: string): RequestInit | undefined {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  if (url.origin !== new URL(backendUrl).origin || !url.pathname.startsWith('/rest/v1/')) return init;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('x-forsure-messaging-revision', MESSAGING_CLIENT_REVISION);
  return { ...init, headers };
}
