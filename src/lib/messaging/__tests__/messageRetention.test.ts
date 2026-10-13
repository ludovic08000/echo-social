import { expect,it } from 'vitest';
import { isMessageExpired,retentionConfirmed,RETENTION_OPTIONS } from '../messageRetention';
it('offers exactly immediate, 24h, 7d and never without treating zero as off',()=>{
  expect(RETENTION_OPTIONS.map(o=>o.seconds)).toEqual([0,86400,604800,null]);
  expect(retentionConfirmed({seconds:0,after_read:true},0)).toBe(true);
  expect(retentionConfirmed({seconds:null,after_read:true},0)).toBe(false);
});
it('requires an explicit server confirmation and rejects incomplete replies',()=>{
  for(const data of [null,{},true,{seconds:86400},{seconds:86400,after_read:false}])
    expect(retentionConfirmed(data,86400)).toBe(false);
});
it('expires on the exact deadline, never while unread or with malformed timestamps',()=>{
  expect(isMessageExpired({id:'1',expires_at:new Date(1000).toISOString()},1000)).toBe(true);
  expect(isMessageExpired({id:'1',expires_at:new Date(1001).toISOString()},1000)).toBe(false);
  expect(isMessageExpired({id:'1',retention_after_read_seconds:0,expires_at:null},1000)).toBe(false);
  expect(isMessageExpired({id:'1',expires_at:'invalid'},1000)).toBe(false);
});
