// Le runtime est généré avec le lockfile npm, puis emporté avec _shared dans Lovable Cloud.
import handler from '../_shared/generated/mcp-handler.mjs';
import { boundedMcpRequest } from '../_shared/mcp-request.ts';

Deno.serve(async (request: Request) => {
  const bounded = await boundedMcpRequest(request);
  if (bounded instanceof Response) return bounded;
  const response = await handler(bounded);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
