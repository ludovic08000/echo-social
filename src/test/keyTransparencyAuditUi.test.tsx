import {beforeEach,expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
const {select,limit,range,verifyHead,verifyBatch}=vi.hoisted(()=>({select:vi.fn(),limit:vi.fn(),range:vi.fn(),verifyHead:vi.fn(),verifyBatch:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:(table:string)=>({select:(value:string)=>{
  select(value);return table==='e2ee_kt_tree_heads'?{order:()=>({limit})}:{eq:()=>({order:()=>({range})})};
}})}}));
vi.mock('@/lib/crypto/ktVerification',async load=>({...await load<object>(),verifyTransparencyHead:verifyHead,verifyTransparencyBatch:verifyBatch}));
vi.mock('react-helmet-async',()=>({Helmet:()=>null}));
import KeyTransparencyAudit from '@/pages/KeyTransparencyAudit';
const head={epoch:1,leaf_count:3,prev_epoch:null,root_hash:'a'.repeat(64),signing_key_id:'key',signature:'ab'.repeat(64),created_at:'2026-10-18T12:00:00Z'};
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();verifyHead.mockResolvedValue('untrusted_authority');verifyBatch.mockResolvedValue(false)});
it('reads actual epoch columns and does not claim an automatic signature verification',async()=>{
  limit.mockResolvedValue({data:[head],error:null});
  render(<MemoryRouter><KeyTransparencyAudit/></MemoryRouter>);
  expect(await screen.findByText('3 entrées dans ce lot')).toBeInTheDocument();
  expect(select).toHaveBeenCalledWith('epoch, leaf_count, prev_epoch, root_hash, signing_key_id, signature, created_at');
  expect(screen.getByText('Autorité absente de la configuration de confiance')).toBeInTheDocument();
  expect(range).not.toHaveBeenCalled();
});
it('never displays a complete verification for a forged or incomplete batch',async()=>{
  limit.mockResolvedValue({data:[head],error:null});verifyHead.mockResolvedValue('verified');
  range.mockResolvedValue({data:[],error:null});verifyBatch.mockResolvedValue(false);
  render(<MemoryRouter><KeyTransparencyAudit/></MemoryRouter>);
  expect(await screen.findByText('Preuve du lot invalide ou incomplète')).toBeInTheDocument();
  expect(localStorage.getItem('forsure:kt:verified-audit-head')).toBeNull();
});
it('records a public checkpoint only after both signature and complete batch verification',async()=>{
  limit.mockResolvedValue({data:[head],error:null});verifyHead.mockResolvedValue('verified');
  range.mockResolvedValue({data:[0,1,2].map(leaf_index=>({leaf_index,leaf_hash:'a'.repeat(64)})),error:null});verifyBatch.mockResolvedValue(true);
  render(<MemoryRouter><KeyTransparencyAudit/></MemoryRouter>);
  expect(await screen.findByText('Signature et intégrité du lot vérifiées')).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('forsure:kt:verified-audit-head')!)).toEqual({epoch:1,root_hash:head.root_hash});
});
it('reports a rollback before fetching or trusting replacement leaves',async()=>{
  localStorage.setItem('forsure:kt:verified-audit-head',JSON.stringify({epoch:2,root_hash:head.root_hash}));
  limit.mockResolvedValue({data:[head],error:null});verifyHead.mockResolvedValue('verified');
  render(<MemoryRouter><KeyTransparencyAudit/></MemoryRouter>);
  expect(await screen.findByText('Régression du registre détectée')).toBeInTheDocument();expect(range).not.toHaveBeenCalled();
});
it('shows a server lookup failure instead of claiming that no epochs exist',async()=>{
  limit.mockResolvedValue({data:null,error:new Error('offline')});
  render(<MemoryRouter><KeyTransparencyAudit/></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('temporairement indisponible');
  expect(screen.queryByText(/Aucune époque publiée/)).not.toBeInTheDocument();
});
