import { describe, expect, it, vi } from 'vitest';
import { partnerMediaThumbnailHandler } from '../../supabase/functions/partner-media-thumbnail/handler';

const id='00000000-0000-4000-8000-000000000401';
const source='https://cdn.publisher.example/photo.png';
const png=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
const request=(query=`?id=${id}`,method='GET')=>new Request(`https://cloud.forsure.test/functions/v1/partner-media-thumbnail${query}`,{method});

describe('partner media thumbnail proxy',()=>{
  it('resolves an eligible item server-side and returns only verified image bytes',async()=>{
    const lookup=vi.fn(async()=>source);
    const fetcher=vi.fn(async()=>new Response(png,{headers:{'content-type':'image/png'}}));
    const response=await partnerMediaThumbnailHandler({lookup,fetcher})(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('s-maxage=86400');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(lookup).toHaveBeenCalledWith(id);
    expect(fetcher).toHaveBeenCalledWith(source,expect.objectContaining({redirect:'error'}));
  });

  it('rejects methods and invalid identifiers before touching the database',async()=>{
    const lookup=vi.fn(async()=>source);
    const handle=partnerMediaThumbnailHandler({lookup,fetcher:vi.fn()});
    expect((await handle(request('', 'POST'))).status).toBe(405);
    expect((await handle(request('?id=not-a-uuid'))).status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not fetch missing, inactive or expired item sources',async()=>{
    const fetcher=vi.fn();
    const response=await partnerMediaThumbnailHandler({lookup:async()=>null,fetcher})(request());
    expect(response.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'http://cdn.publisher.example/a.png','https://user:pass@cdn.publisher.example/a.png',
    'https://cdn.publisher.example:444/a.png','https://localhost/a.png','https://127.0.0.1/a.png','https://[::1]/a.png',
  ])('blocks unsafe upstream %s',async unsafe=>{
    const fetcher=vi.fn();
    const response=await partnerMediaThumbnailHandler({lookup:async()=>unsafe,fetcher})(request());
    expect(response.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unsupported types and mismatched file signatures',async()=>{
    const svg=partnerMediaThumbnailHandler({lookup:async()=>source,fetcher:async()=>new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}})});
    expect((await svg(request())).status).toBe(415);
    const fake=partnerMediaThumbnailHandler({lookup:async()=>source,fetcher:async()=>new Response('<html/>',{headers:{'content-type':'image/png'}})});
    expect((await fake(request())).status).toBe(415);
  });

  it('bounds declared image size and fails closed when lookup or network is unavailable',async()=>{
    const large=partnerMediaThumbnailHandler({lookup:async()=>source,fetcher:async()=>new Response(png,{headers:{'content-type':'image/png','content-length':String(4*1024*1024)}})});
    expect((await large(request())).status).toBe(413);
    expect((await partnerMediaThumbnailHandler({lookup:async()=>{throw new Error('db');}})(request())).status).toBe(503);
    expect((await partnerMediaThumbnailHandler({lookup:async()=>source,fetcher:async()=>{throw new Error('network');}})(request())).status).toBe(502);
  });
});
