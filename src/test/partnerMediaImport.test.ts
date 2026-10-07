import { describe,expect,it } from 'vitest';
import { validateMediaBatch } from '../../scripts/import-partner-media.mjs';
const partner='00000000-0000-4000-8000-000000000001';
const item={external_id:'test',title:'Test',kind:'article',canonical_url:'https://media.invalid/article',published_at:'2026-10-05T10:00:00Z',expires_at:'2026-10-06T10:00:00Z'};
describe('offline licensed media import validation',()=>{
  it('accepts metadata only without network access',()=>expect(validateMediaBatch(partner,[item])).toEqual([item]));
  it('rejects forged approvals, duplicates, scripts and arbitrary embed HTML',()=>{
    for(const batch of [[{...item,moderated:true}],[item,item],[{...item,canonical_url:'javascript:alert(1)'}],[{...item,youtube_id:'<iframe />'}]])
      expect(()=>validateMediaBatch(partner,batch)).toThrow();
  });
  it('bounds batches and requires consistent expiry',()=>{
    expect(()=>validateMediaBatch(partner,Array(51).fill(item))).toThrow();
    expect(()=>validateMediaBatch(partner,[{...item,expires_at:'2000-01-01'}])).toThrow();
    expect(()=>validateMediaBatch('wrong',[item])).toThrow();
  });
});
