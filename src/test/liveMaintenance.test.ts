// @vitest-environment node
import { describe,it,expect,vi } from 'vitest';
import { maintainLives } from '../../supabase/functions/_shared/live-maintenance.ts';
const id='11111111-1111-4111-8111-111111111111';

function fakeDb({ active=[],expired=[],roomLive=null }={}) {
  const deleted=vi.fn(); const updated=vi.fn();
  const db={from:vi.fn(()=>{
    const filters:Record<string,unknown>={}; let operation='select';
    const query={
      select:()=>query,order:()=>query,
      eq:(key,value)=>{filters[key]=value;return query;},lte:()=>query,
      update:()=>{operation='update';return query;},delete:()=>{operation='delete';return query;},
      limit:async()=>({data:filters.is_active===false?expired:active,error:null}),
      maybeSingle:async()=>({data:roomLive,error:null}),
      then:resolve=>{if(operation==='delete')deleted(filters.id);if(operation==='update')updated(filters.id);return Promise.resolve({error:null}).then(resolve);},
    };
    return query;
  })};
  return {db:db as unknown as Parameters<typeof maintainLives>[0],deleted,updated};
}

describe('live maintenance does not leak into calls or unsafe archive deletion',()=>{
  it('closes expired broadcast rooms but never touches an Aegis call room',async()=>{
    const {db,updated}=fakeDb({active:[{id}],roomLive:{is_active:false,started_at:'2026-11-01T00:00:00Z'}});
    const rooms={listRooms:async()=>[{name:`live-${id}`},{name:`call-${id}`}],deleteRoom:vi.fn()};
    const result=await maintainLives(db,rooms,vi.fn(),Date.parse('2026-11-04T00:00:00Z'));
    expect(updated).toHaveBeenCalledWith(id);
    expect(rooms.deleteRoom).toHaveBeenCalledExactlyOnceWith(`live-${id}`);
    expect(result.rooms_closed).toBe(1);
  });
  it('keeps the database archive for retry when media deletion cannot be confirmed',async()=>{
    const {db,deleted}=fakeDb({expired:[{id,user_id:id,recording_url:'unverified',archive_expires_at:'2026-11-01'}]});
    const result=await maintainLives(db,{listRooms:async()=>[],deleteRoom:vi.fn()},async()=>{throw new Error('ownership unknown');});
    expect(deleted).not.toHaveBeenCalled();
    expect(result).toMatchObject({purged:0,errors:1});
  });
  it('deletes the archive record only after all associated media have been handled',async()=>{
    const {db,deleted}=fakeDb({expired:[{id,user_id:id,recording_url:'recording',thumbnail_url:'poster',archive_expires_at:'2026-11-01'}]});
    const handled=[];
    await maintainLives(db,{listRooms:async()=>[],deleteRoom:vi.fn()},async(url)=>{expect(deleted).not.toHaveBeenCalled();handled.push(url);});
    expect(handled).toEqual(['recording','poster']);
    expect(deleted).toHaveBeenCalledWith(id);
  });
});
