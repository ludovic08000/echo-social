// @vitest-environment node
import {expect,it,vi} from 'vitest';
import {boundedMcpRequest} from '../../supabase/functions/_shared/mcp-request';
it('preserves an ordinary authenticated request byte-for-byte without reading its JSON',async()=>{
  const request=new Request('https://local.invalid',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:'{"method":"tools/list"}'});
  const next=await boundedMcpRequest(request);expect(next).toBeInstanceOf(Request);
  expect((next as Request).headers.get('Authorization')).toBe('Bearer synthetic');
  expect(await next.text()).toBe('{"method":"tools/list"}');
});
it('also bounds a stream that never finishes without retaining a dangling timer',async()=>{
  vi.useFakeTimers();
  try {
    const body=new ReadableStream({pull(){/* Le réseau ne termine pas. */}});
    const result=boundedMcpRequest(new Request('https://local.invalid',{method:'POST',body,duplex:'half'} as RequestInit));
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result as Response).status).toBe(408);
    expect(vi.getTimerCount()).toBe(0);
  } finally {vi.useRealTimers()}
});
it('bounds both the declared and actual streamed body before the SDK parses it',async()=>{
  const declared=new Request('https://local.invalid',{method:'POST',headers:{'Content-Length':'2000000'},body:'x'});
  expect((await boundedMcpRequest(declared) as Response).status).toBe(413);
  const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(600000));controller.enqueue(new Uint8Array(600000));controller.close()}});
  const streamed=new Request('https://local.invalid',{method:'POST',body,duplex:'half'} as RequestInit);
  expect((await boundedMcpRequest(streamed) as Response).status).toBe(413);
});
it('returns a bounded client error for an unreadable body and keeps bodyless preflight unchanged',async()=>{
  const body=new ReadableStream({pull(controller){controller.error(new Error('unreadable'))}});
  expect((await boundedMcpRequest(new Request('https://local.invalid',{method:'POST',body,duplex:'half'} as RequestInit)) as Response).status).toBe(400);
  const preflight=new Request('https://local.invalid',{method:'OPTIONS'});
  expect(await boundedMcpRequest(preflight)).toBe(preflight);
});
