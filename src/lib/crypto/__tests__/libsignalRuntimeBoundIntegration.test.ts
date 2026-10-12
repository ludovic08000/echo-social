// @vitest-environment node
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as wasm from '../wasm/generated/aegis_crypto';
import { signLibsignalBundleBinding } from '../libsignalBundleBinding';

const m = vi.hoisted(()=>({ records:new Map<string,unknown>(),rpc:vi.fn(),device:vi.fn(),trust:vi.fn(),claims:0 }));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc}}));
vi.mock('../deviceLinkTrust',()=>({getApprovedDeviceIdentity:m.device}));
vi.mock('../fingerprintTracker',()=>({assertExactPeerFingerprintTrusted:m.trust}));
vi.mock('@capacitor/core',()=>({Capacitor:{getPlatform:()=> 'web'},registerPlugin:()=>({})}));
vi.mock('@/lib/runtimePlatform',()=>({isVerifiedNativeRuntime:()=>false}));
vi.mock('../deviceVault',()=>({
  readDeviceVaultRecord:async(id:string,valid:(value:unknown)=>boolean)=>{const v=m.records.get(id);return valid(v)?v:null;},
  writeDeviceVaultRecord:async(id:string,value:unknown)=>{m.records.set(id,value);},
}));
vi.mock('../libsignalStoreLock',()=>({withLibsignalStoreLock:(_u:string,_d:string,work:()=>unknown)=>work()}));
vi.mock('../libsignalSessionFreshness',()=>({withLibsignalSessionFreshness:(_args:unknown,work:(renew:boolean,established:()=>Promise<void>)=>unknown)=>work(false,async()=>undefined)}));
vi.mock('@/lib/device-manager/deviceFinalizationTrace',async(importOriginal)=>({
  ...await importOriginal<typeof import('@/lib/device-manager/deviceFinalizationTrace')>(),
  traceFinalizationOperation:(_s:string,work:()=>unknown)=>work(),
}));
import { encryptForLibsignalDevice, decodeLibsignalWire } from '../libsignalRuntime';
import { __libsignalDeviceNumberTest } from '../libsignalDeviceNumber';
const owner = {conversationId:'conv',ownerUserId:'alice',ownerDeviceId:'pc',remoteUserId:'bob',remoteDeviceId:'ios'};
const storeId = 'aegis.libsignal.store:alice:pc';
const unpack = (bytes: Uint8Array) => {
  const parts:Uint8Array[]=[]; let offset=0;
  while(offset<bytes.length){const n=new DataView(bytes.buffer,bytes.byteOffset+offset,4).getUint32(0,true);offset+=4;parts.push(bytes.slice(offset,offset+n));offset+=n;}
  return parts;
};
let bob:Uint8Array; let bobBundle:Uint8Array;
beforeAll(async()=>{
  await wasm.default({module_or_path:readFileSync('src/lib/crypto/wasm/generated/aegis_crypto_bg.wasm')});
});
beforeEach(async()=>{
  vi.clearAllMocks(); vi.stubGlobal('window',Object.assign(new EventTarget(),{isSecureContext:true}));
  m.records.clear();m.claims=0; __libsignalDeviceNumberTest.reset();
  m.records.set(storeId,{bytes:Buffer.from(wasm.aegis_wasm_store_create(101)).toString('base64')});
  [bob,bobBundle]=unpack(await wasm.aegis_wasm_bundle_create(wasm.aegis_wasm_store_create(202),2,11,12,13));
  const signing=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
  const signingKey=Buffer.from(await crypto.subtle.exportKey('raw',signing.publicKey)).toString('base64');
  const publicBundle=Buffer.from(bobBundle).toString('base64');
  const signature=await signLibsignalBundleBinding({userId:'bob',deviceId:'ios',deviceNumber:2,registrationId:202,publicBundle},signing.privateKey);
  m.device.mockResolvedValue({deviceId:'ios',deviceSigningKey:signingKey,accountFingerprint:'known-account'});
  m.trust.mockResolvedValue(undefined);
  m.rpc.mockImplementation((name:string,args:{p_user_id:string})=>{
    if(name==='get_libsignal_device_number') return {abortSignal:async()=>({data:args.p_user_id==='alice'?1:2,error:null})};
    if(name==='claim_libsignal_prekey_bundle') {m.claims++; return Promise.resolve({data:[{device_number:2,registration_id:202,public_bundle:publicBundle,bundle_signature:signature}],error:null});}
    throw new Error(`unexpected RPC ${name}`);
  });
});
afterEach(()=>vi.unstubAllGlobals());
async function receive(wire:string) {
  const message=decodeLibsignalWire(wire)!;
  const [next,plaintext]=unpack(await wasm.aegis_wasm_message_decrypt(bob,'bob',2,'alice',1,message.messageType,message.ciphertext));
  bob=next; return new TextDecoder().decode(plaintext);
}
it('sends first and warm messages through real proof verification, vault commits and real PQXDH',async()=>{
  for(const plaintext of ['Bonjour 👋','Second message','Toujours la même identité']) {
    const wire=await encryptForLibsignalDevice({...owner,plaintext});
    expect(await receive(wire)).toBe(plaintext);
  }
  expect(m.claims).toBe(1);
  expect(m.trust).toHaveBeenCalledTimes(3);
  expect(m.device).toHaveBeenCalledTimes(3);
});
it('upgrades a pre-existing matching session without discarding delayed messages',async()=>{
  let alice=await wasm.aegis_wasm_session_establish(wasm.aegis_wasm_store_create(101),'alice',1,'bob',2,bobBundle);
  const [next,type,delayed]=unpack(await wasm.aegis_wasm_message_encrypt(alice,'alice',1,'bob',2,new TextEncoder().encode('old queued message')));
  alice=next;
  m.records.set(storeId,{bytes:Buffer.from(alice).toString('base64')});
  const wire=await encryptForLibsignalDevice({...owner,plaintext:'after upgrade'});
  expect(await receive(wire)).toBe('after upgrade');
  expect(await receive(`aegis.libsignal.${type[0]}.${Buffer.from(delayed).toString('base64')}`)).toBe('old queued message');
  expect(m.claims).toBe(1);
});
it('blocks an existing session bound to an impostor while leaving the stored ratchet untouched',async()=>{
  const [,fakeBundle]=unpack(await wasm.aegis_wasm_bundle_create(wasm.aegis_wasm_store_create(999),2,21,22,23));
  const poisoned=await wasm.aegis_wasm_session_establish(wasm.aegis_wasm_store_create(101),'alice',1,'bob',2,fakeBundle);
  const before={bytes:Buffer.from(poisoned).toString('base64')};m.records.set(storeId,before);
  await expect(encryptForLibsignalDevice({...owner,plaintext:'must never leave'})).rejects.toThrow('AEGIS_LIBSIGNAL_IDENTITY_BINDING_INVALID');
  expect(m.records.get(storeId)).toEqual(before);
  expect([...m.records.keys()].some(k=>k.startsWith('aegis:libsignal-binding:'))).toBe(false);
});
it('refuses a revoked device on the next warm send without consuming a prekey or advancing the ratchet',async()=>{
  await encryptForLibsignalDevice({...owner,plaintext:'before revocation'});
  const before=m.records.get(storeId);
  m.device.mockRejectedValueOnce(new Error('DEVICE_ROUTE_NOT_AUTHORIZED'));
  await expect(encryptForLibsignalDevice({...owner,plaintext:'after revocation'})).rejects.toThrow('DEVICE_ROUTE_NOT_AUTHORIZED');
  expect(m.claims).toBe(1);expect(m.records.get(storeId)).toEqual(before);
});
