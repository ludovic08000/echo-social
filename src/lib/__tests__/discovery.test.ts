import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DISCOVERY, discoveryPayload, partnerThumbnailUrl, safePartnerUrl, youtubeEmbedUrl } from '../discovery';
import { locationHandler, trustedLocationIp } from '../../../supabase/functions/local-media-location/location';
import { dbipFromCloud } from '../../../supabase/functions/_shared/dbip-storage';

describe('discovery privacy boundaries', () => {
  it('defaults to no profiling or location and forgets disabled location', () => {
    expect(Object.values(DEFAULT_DISCOVERY).filter(Boolean)).toEqual([]);
    expect(discoveryPayload({ ...DEFAULT_DISCOVERY, city: 'Paris', country: 'FR' }))
      .toEqual({ ...DEFAULT_DISCOVERY });
    expect(discoveryPayload({ ...DEFAULT_DISCOVERY, ads_location: true, city: 'Paris', country: 'FR' }))
      .toEqual({ ...DEFAULT_DISCOVERY, ads_location: true, city: 'Paris', country: 'FR' });
    expect(discoveryPayload({ ...DEFAULT_DISCOVERY, ads_location_auto: true }).ads_location_auto).toBe(false);
    expect(discoveryPayload({ ...DEFAULT_DISCOVERY, local_media: true, country: ' fr ', city: ' Reims ' }).country).toBe('FR');
  });
  it.each(['javascript:alert(1)', 'http://site.test/', 'https://user:pass@site.test/', 'https://site.test\\@evil.test/', '\nhttps://site.test/'])('rejects unsafe URL %s', value => {
    expect(safePartnerUrl(value)).toBeNull();
  });
  it('restricts embeds to validated YouTube IDs, not publisher-supplied HTML', () => {
    expect(safePartnerUrl('https://media.test/article')).toBe('https://media.test/article');
    expect(youtubeEmbedUrl('abcdefghijk')).toBe('https://www.youtube-nocookie.com/embed/abcdefghijk?autoplay=0');
    expect(youtubeEmbedUrl('https://evil.test')).toBeNull();
    expect(youtubeEmbedUrl(null)).toBeNull();
  });
  it('routes partner thumbnails through the ForSure backend without exposing the publisher URL', () => {
    const item='00000000-0000-4000-8000-000000000401';
    expect(partnerThumbnailUrl(item,'https://publisher.test/photo.jpg','https://cloud.forsure.test'))
      .toBe(`https://cloud.forsure.test/functions/v1/partner-media-thumbnail?id=${item}`);
    expect(partnerThumbnailUrl('not-a-uuid','https://publisher.test/photo.jpg','https://cloud.forsure.test')).toBeNull();
    expect(partnerThumbnailUrl(item,null,'https://cloud.forsure.test')).toBeNull();
    expect(partnerThumbnailUrl(item,'https://publisher.test/photo.jpg','http://cloud.forsure.test')).toBeNull();
  });
  it('requires a configured trusted gateway and ignores arbitrary client geography', () => {
    const headers=new Headers({ 'cf-connecting-ip':'8.8.8.8','x-real-ip':'192.168.1.1','x-forwarded-for':'8.8.4.4, 1.1.1.1','cf-ipcountry':'FR' });
    expect(trustedLocationIp(headers)).toBeNull();
    expect(trustedLocationIp(headers,'cf-connecting-ip')).toBe('8.8.8.8');
    expect(trustedLocationIp(headers,'x-real-ip')).toBeNull();
    expect(trustedLocationIp(headers,'x-forwarded-for')).toBe('1.1.1.1');
    expect(trustedLocationIp(new Headers({'x-real-ip':'ff02::1'}),'x-real-ip')).toBeNull();
  });
  it('does not call any provider or paid fallback without configured private City Lite data', async () => {
    const fetcher=vi.fn();
    const lookup=dbipFromCloud(()=>undefined,fetcher);
    expect(await lookup('8.8.8.8')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never calls the provider before authentication, explicit consent and rate limiting', async () => {
    const deps={authenticate:vi.fn(async()=> 'user'),allow:vi.fn(async()=>true),locate:vi.fn(async()=>({country:'FR',city:null,region:null})),cors:()=>({})};
    const handle=locationHandler(deps);
    const req=(body:unknown,authorization='Bearer test')=>new Request('https://test.invalid/',{method:'POST',headers:{authorization},body:JSON.stringify(body)});
    expect((await handle(req({consent:true},''))).status).toBe(401);
    expect((await handle(req({consent:false}))).status).toBe(400);
    expect((await handle(req({consent:true,ip:'1.1.1.1'}))).status).toBe(400);
    expect((await handle(req({consent:true,payload:'x'.repeat(100)}))).status).toBe(413);
    expect(deps.locate).not.toHaveBeenCalled();
    deps.allow.mockResolvedValueOnce(false);
    expect((await handle(req({consent:true}))).status).toBe(429);
    expect(deps.locate).not.toHaveBeenCalled();
    const result=await handle(req({consent:true}));
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({country:'FR',city:null,region:null});
    deps.authenticate.mockRejectedValueOnce(new Error('backend down'));
    expect((await handle(req({consent:true}))).status).toBe(503);
    expect(deps.locate).toHaveBeenCalledTimes(1);
  });
});
