import { fireEvent,render,screen,within,waitFor } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { beforeEach,expect,it,vi } from 'vitest';
const f=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:f.rpc}}));
import { ZeusCapabilitiesPanel } from './ZeusCapabilitiesPanel';
const policy={capability:'messages.send',enabled:true,minimum_confirmation:true,require_confirmation:true,required_role:null,paid_only:false,revision:1};
beforeEach(()=>f.rpc.mockReset());
function open(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><ZeusCapabilitiesPanel/></QueryClientProvider>);fireEvent.click(screen.getByText('Capacités Zeus'));}
it('keeps the mandatory confirmation disabled in the admin editor',async()=>{
  f.rpc.mockResolvedValue({data:[policy],error:null});open();
  const group=await screen.findByRole('group',{name:'Envoyer un message'});
  expect(within(group).getByRole('checkbox',{name:'Confirmation'})).toBeDisabled();
});
it('sends the expected revision and displays the role only after a confirmed server update',async()=>{
  let current=policy;
  f.rpc.mockImplementation(async(name:string)=>{
    if(name==='zeus_set_capability_policy'){current={...policy,revision:2,required_role:'admin'};return {data:current,error:null};}
    return {data:[current],error:null};
  });open();
  const group=await screen.findByRole('group',{name:'Envoyer un message'});
  fireEvent.change(within(group).getByRole('combobox'),{target:{value:'admin'}});
  await waitFor(()=>expect(within(group).getByRole('combobox')).toHaveValue('admin'));
  expect(f.rpc).toHaveBeenCalledWith('zeus_set_capability_policy',expect.objectContaining({p_capability:'messages.send',p_revision:1,p_required_role:'admin'}));
});
it('reports an unconfirmed update and keeps the existing capability state',async()=>{
  f.rpc.mockImplementation(async(name:string)=>({data:name==='zeus_set_capability_policy'?null:[policy],error:null}));open();
  const group=await screen.findByRole('group',{name:'Envoyer un message'});
  fireEvent.click(within(group).getByRole('checkbox',{name:'Activée'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('n’est pas confirmée');
  expect(within(group).getByRole('checkbox',{name:'Activée'})).toBeChecked();
});
