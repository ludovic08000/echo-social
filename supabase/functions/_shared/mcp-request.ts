const MAX_MCP_BYTES = 1_048_576;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };

export async function boundedMcpRequest(request: Request): Promise<Request | Response> {
  if (!request.body) return request;
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_MCP_BYTES)) {
    void request.body.cancel().catch(() => undefined);
    return new Response(JSON.stringify({ error: 'MCP_REQUEST_TOO_LARGE' }), { status: 413, headers: JSON_HEADERS });
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let timedOut=false;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new Error('MCP_BODY_TIMEOUT'))},5000)});
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(),deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MCP_BYTES) {
        void reader.cancel().catch(() => undefined);
        return new Response(JSON.stringify({ error: 'MCP_REQUEST_TOO_LARGE' }), { status: 413, headers: JSON_HEADERS });
      }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return new Response(JSON.stringify({ error: timedOut?'MCP_BODY_TIMEOUT':'MCP_REQUEST_UNREADABLE' }), { status: timedOut?408:400, headers: JSON_HEADERS });
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request, { body });
}
