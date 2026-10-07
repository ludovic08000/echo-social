import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DISCOVERY } from '@/lib/discovery';
import { DiscoveryPreferencesPanel } from '../DiscoveryPreferencesPanel';
const mocks=vi.hoisted(()=>({mutate:vi.fn(),invoke:vi.fn(),rpc:vi.fn(),user:'user-one'}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:{id:mocks.user}})}));
vi.mock('@/hooks/useDiscoveryPreferences',()=>({useDiscoveryPreferences:()=>({data:DEFAULT_DISCOVERY,isLoading:false,isError:false}),useSaveDiscoveryPreferences:()=>({mutate:mocks.mutate,isPending:false})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{functions:{invoke:mocks.invoke},rpc:mocks.rpc}}));
vi.mock('sonner',()=>({toast:{info:vi.fn(),error:vi.fn(),success:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.user='user-one';});
describe('explicit discovery consent',()=>{
  it('shows translated proposals and attribution but saves canonical targeting names',async()=>{
    mocks.invoke.mockResolvedValue({data:{country:'FR',region:'Grand Est',city:'Reims',display:{country:'フランス',region:'グラン・テスト',city:'ランス'}},error:null});
    render(<MemoryRouter><DiscoveryPreferencesPanel /></MemoryRouter>);
    fireEvent.click(screen.getByRole('switch',{name:'Publicités de ma ville et de ma région'}));
    expect(screen.getByRole('link',{name:'DB-IP'})).toHaveAttribute('href','https://db-ip.com');
    expect(screen.getByRole('link',{name:'CC BY 4.0'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Détecter ma zone avec DB-IP'}));
    fireEvent.click(await screen.findByRole('button',{name:'ランス · グラン・テスト · フランス'}));
    expect(screen.getByLabelText('Ville')).toHaveValue('Reims');
    fireEvent.click(screen.getByRole('button',{name:'Enregistrer mes choix'}));
    expect(mocks.mutate.mock.calls[0][0]).toMatchObject({country:'FR',region:'Grand Est',city:'Reims',ads_location:true});
  });
  it('does nothing on mount and saves only after the explicit button',()=>{
    render(<MemoryRouter><DiscoveryPreferencesPanel /></MemoryRouter>);
    expect(mocks.mutate).not.toHaveBeenCalled();expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch',{name:'Publicités selon mes intérêts déclarés'}));
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Enregistrer mes choix'}));
    expect(mocks.mutate.mock.calls[0][0]).toEqual({...DEFAULT_DISCOVERY,ads_profile:true});
  });
  it('treats IP lookup as a proposal after local ads opt-in and never saves automatically',async()=>{
    mocks.invoke.mockResolvedValue({data:{country:'FR',region:'Grand Est',city:'Reims'},error:null});
    render(<MemoryRouter><DiscoveryPreferencesPanel /></MemoryRouter>);
    fireEvent.click(screen.getByRole('switch',{name:'Publicités de ma ville et de ma région'}));
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Détecter ma zone avec DB-IP'}));
    await screen.findByRole('button',{name:'Reims · Grand Est · FR'});
    expect(screen.getByLabelText('Ville')).toHaveValue('');
    fireEvent.click(screen.getByRole('button',{name:'Reims · Grand Est · FR'}));
    expect(screen.getByLabelText('Ville')).toHaveValue('Reims');
    expect(mocks.invoke).toHaveBeenCalledWith('local-media-location',{body:{consent:true},headers:{'Accept-Language':navigator.languages.join(',')}});
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('switch',{name:'Publicités de ma ville et de ma région'})).toBeChecked();
  });
  it('confirms a profile city and its region only after local ads opt-in',async()=>{
    mocks.rpc.mockResolvedValue({data:'Reims',error:null});
    mocks.invoke.mockResolvedValue({data:{cities:[{code:'51454',country:'FR',city:'Reims',region:'Grand Est',department:'Marne'}]},error:null});
    render(<MemoryRouter><DiscoveryPreferencesPanel /></MemoryRouter>);
    fireEvent.click(screen.getByRole('switch',{name:'Publicités de ma ville et de ma région'}));
    fireEvent.click(screen.getByRole('button',{name:'Utiliser la ville de mon profil'}));
    fireEvent.click(await screen.findByRole('button',{name:'Reims · Marne · Grand Est · FR'}));
    expect(mocks.rpc).toHaveBeenCalledWith('get_my_media_profile_city');
    expect(mocks.invoke).toHaveBeenCalledWith('local-media-location',{body:{cityQuery:'Reims'}});
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Enregistrer mes choix'}));
    expect(mocks.mutate.mock.calls[0][0]).toEqual({...DEFAULT_DISCOVERY,ads_location:true,country:'FR',city:'Reims',region:'Grand Est'});
  });
  it('does not overwrite a manual choice with an IP suggestion',async()=>{
    mocks.invoke.mockResolvedValue({data:{country:'FR',region:'Île-de-France',city:'Paris'},error:null});
    render(<MemoryRouter><DiscoveryPreferencesPanel /></MemoryRouter>);
    fireEvent.click(screen.getByRole('switch',{name:'Publicités de ma ville et de ma région'}));
    fireEvent.change(screen.getByLabelText('Ville'),{target:{value:'Reims'}});
    fireEvent.click(screen.getByRole('button',{name:'Détecter ma zone avec DB-IP'}));
    await screen.findByRole('button',{name:'Paris · Île-de-France · FR'});
    expect(screen.getByLabelText('Ville')).toHaveValue('Reims');
  });
  it('drops an old account response after switching accounts',async()=>{
    let resolve!: (v:unknown)=>void;
    mocks.invoke.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const {rerender}=render(<MemoryRouter><DiscoveryPreferencesPanel /></MemoryRouter>);
    fireEvent.click(screen.getByRole('switch',{name:'Publicités de ma ville et de ma région'}));
    fireEvent.click(screen.getByRole('button',{name:'Détecter ma zone avec DB-IP'}));
    mocks.user='user-two';rerender(<MemoryRouter><DiscoveryPreferencesPanel /></MemoryRouter>);
    resolve({data:{country:'FR',city:'Paris',region:'Île-de-France'},error:null});
    await waitFor(()=>expect(screen.queryByRole('group',{name:'Zones proposées'})).toBeNull());
    expect(screen.queryByRole('group',{name:'Zones proposées'})).toBeNull();
  });
  it('does not expose a switch that can disable automatic contextual news',()=>{
    render(<MemoryRouter><DiscoveryPreferencesPanel /></MemoryRouter>);
    expect(screen.queryByRole('switch',{name:'Médias de ma ville et de ma région'})).toBeNull();
    expect(screen.getByText(/actualités utilisent automatiquement/i)).toBeInTheDocument();
  });
  it('keeps local ads independent of news and requires a separate opt-in for auto location',()=>{
    render(<MemoryRouter><DiscoveryPreferencesPanel /></MemoryRouter>);
    expect(screen.getByRole('switch',{name:'Trouver automatiquement ma zone publicitaire'})).toBeDisabled();
    fireEvent.click(screen.getByRole('switch',{name:'Publicités de ma ville et de ma région'}));
    expect(screen.getByRole('switch',{name:'Trouver automatiquement ma zone publicitaire'})).not.toBeChecked();
    fireEvent.click(screen.getByRole('switch',{name:'Trouver automatiquement ma zone publicitaire'}));
    fireEvent.click(screen.getByRole('button',{name:'Enregistrer mes choix'}));
    expect(mocks.mutate.mock.calls[0][0]).toEqual({...DEFAULT_DISCOVERY,ads_location:true,ads_location_auto:true});
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch',{name:'Publicités de ma ville et de ma région'}));
    expect(screen.getByRole('switch',{name:'Trouver automatiquement ma zone publicitaire'})).not.toBeChecked();
  });
  it('clears the selected zone without implicitly consenting to automatic ads',()=>{
    render(<MemoryRouter><DiscoveryPreferencesPanel /></MemoryRouter>);
    fireEvent.click(screen.getByRole('switch',{name:'Publicités de ma ville et de ma région'}));
    fireEvent.change(screen.getByLabelText('Ville'),{target:{value:'Reims'}});
    fireEvent.click(screen.getByRole('button',{name:'Effacer la zone choisie'}));
    expect(screen.getByLabelText('Ville')).toHaveValue('');
    expect(screen.getByRole('switch',{name:'Trouver automatiquement ma zone publicitaire'})).not.toBeChecked();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
