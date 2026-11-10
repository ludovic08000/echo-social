import { expect,it,vi } from 'vitest';
import { launchOutgoingCall } from '../launchOutgoingCall';
function fixture(){return {conversationId:'conversation',callerId:'caller',recipientId:'peer',type:'audio' as const,createKey:vi.fn(()=>'synthetic-key'),signal:vi.fn().mockResolvedValue('call'),start:vi.fn().mockResolvedValue(true),end:vi.fn().mockResolvedValue(undefined),active:vi.fn()};}
it('uses the existing signaling and media paths and returns no key to the assistant',async()=>{
  const f=fixture();expect(await launchOutgoingCall(f)).toBe(true);
  expect(f.signal).toHaveBeenCalledExactlyOnceWith('conversation','caller','peer','audio','synthetic-key');
  expect(f.start).toHaveBeenCalledExactlyOnceWith('call','audio','synthetic-key');
  expect(f.end).not.toHaveBeenCalled();
});
it('does not join a room if the server has not created the call',async()=>{
  const f=fixture();f.signal.mockResolvedValue(null);await expect(launchOutgoingCall(f)).rejects.toThrow(/confirmé/);expect(f.start).not.toHaveBeenCalled();
});
it.each([false,'error'])('closes only the newly created signaling record when media cannot start (%s)',async outcome=>{
  const f=fixture();if(outcome==='error')f.start.mockRejectedValue(new Error('media unavailable'));else f.start.mockResolvedValue(false);
  if(outcome==='error')await expect(launchOutgoingCall(f)).rejects.toThrow('media unavailable');else expect(await launchOutgoingCall(f)).toBe(false);
  expect(f.end).toHaveBeenCalledExactlyOnceWith('call');expect(f.active).toHaveBeenLastCalledWith(null);
});
it('ends the newly created call without starting media if the user cancelled while signaling',async()=>{
  const f=fixture();let cancelled=false;let finish!:(id:string)=>void;
  f.signal.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const result=launchOutgoingCall({...f,cancelled:()=>cancelled});
  cancelled=true;finish('call');
  expect(await result).toBe(false);
  expect(f.start).not.toHaveBeenCalled();
  expect(f.end).toHaveBeenCalledExactlyOnceWith('call');
});
