import { render,screen,fireEvent,waitFor,cleanup } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({read:vi.fn(),rpc:vi.fn(),success:vi.fn(),error:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{
  from:()=>({select:()=>({eq:()=>({maybeSingle:mocks.read})})}),rpc:mocks.rpc,
}}));
vi.mock('sonner',()=>({toast:{success:mocks.success,error:mocks.error}}));
import { DisappearingMessagesDialog } from '../DisappearingMessagesDialog';
afterEach(cleanup);
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({data:{disappearing_seconds:null,disappearing_after_read:true},error:null});
});
it('saves zero as immediate only after explicit server confirmation',async()=>{
  const close=vi.fn();mocks.rpc.mockResolvedValue({data:{seconds:0,after_read:true},error:null});
  render(<DisappearingMessagesDialog open onOpenChange={close} conversationId="conversation"/>);
  fireEvent.click(await screen.findByRole('radio',{name:'Dès qu’ils ont été lus'}));
  fireEvent.click(screen.getByRole('button',{name:'Enregistrer'}));
  await waitFor(()=>expect(mocks.rpc).toHaveBeenCalledWith('set_conversation_retention',{p_conversation_id:'conversation',p_seconds:0}));
  await waitFor(()=>expect(close).toHaveBeenCalledWith(false));
  expect(mocks.success).toHaveBeenCalledWith('Suppression : Dès qu’ils ont été lus');
});
it('does not announce success or close on an incomplete response',async()=>{
  const close=vi.fn();mocks.rpc.mockResolvedValue({data:null,error:null});
  render(<DisappearingMessagesDialog open onOpenChange={close} conversationId="conversation"/>);
  await screen.findByRole('radio',{name:'Jamais'});fireEvent.click(screen.getByRole('button',{name:'Enregistrer'}));
  await waitFor(()=>expect(mocks.error).toHaveBeenCalled());
  expect(mocks.success).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
});
it('blocks saving if the server setting cannot be loaded',async()=>{
  mocks.read.mockResolvedValue({data:null,error:{message:'unavailable'}});
  render(<DisappearingMessagesDialog open onOpenChange={vi.fn()} conversationId="conversation"/>);
  await screen.findByRole('alert');expect(screen.getByRole('button',{name:'Enregistrer'})).toBeDisabled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('does not silently convert an existing send-based timer into never',async()=>{
  mocks.read.mockResolvedValue({data:{disappearing_seconds:2592000,disappearing_after_read:false},error:null});
  render(<DisappearingMessagesDialog open onOpenChange={vi.fn()} conversationId="conversation"/>);
  await screen.findByRole('status');expect(screen.getByRole('button',{name:'Enregistrer'})).toBeDisabled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
