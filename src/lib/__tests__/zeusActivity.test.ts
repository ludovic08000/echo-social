import { beforeEach,expect,it,vi } from 'vitest';
const f=vi.hoisted(()=>({rpc:vi.fn(),getSession:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:f.rpc,auth:{getSession:f.getSession}}}));
import { loadZeusActivity } from '../zeusActivity';
const activity={unread_messages:2,unread_notifications:4,publication_replies:1,friend_requests:0,checked_at:new Date().toISOString()};
beforeEach(()=>{vi.resetAllMocks();f.getSession.mockResolvedValue({data:{session:{user:{id:'first'}}}});f.rpc.mockResolvedValue({data:activity,error:null});});
it('returns a fresh activity only for the expected signed-in actor',async()=>{
  expect(await loadZeusActivity('first')).toMatchObject(activity);
});
it('rejects a delayed result after an account switch instead of caching or speaking it',async()=>{
  f.rpc.mockImplementation(async()=>{f.getSession.mockResolvedValue({data:{session:{user:{id:'second'}}}});return {data:activity,error:null};});
  await expect(loadZeusActivity('first')).rejects.toThrow(/compte connecté a changé/);
});
