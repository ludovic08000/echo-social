// @vitest-environment node
import { beforeAll,beforeEach,afterEach,it,expect,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as wasm from '../wasm/generated/aegis_crypto';
const m=vi.hoisted(()=>({records:new Map<string,unknown>(),rpc:vi.fn(),trust:vi.fn(),write:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc}}));
vi.mock('../fingerprintTracker',()=>({assertExactPeerFingerprintTrusted:m.trust}));
vi.mock('@capacitor/core',()=>({Capacitor:{getPlatform:()=> 'web'},registerPlugin:()=>({})}));
vi.mock('@/lib/runtimePlatform',()=>({isVerifiedNativeRuntime:()=>false}));
vi.mock('../deviceVault',()=>({
  readDeviceVaultRecord:async(id:string,valid:(v:unknown)=>boolean)=>{const v=m.records.get(id); if(v===undefined)return null;if(!valid(v))throw new Error('VAULT_CORRUPT');return v;},
  writeDeviceVaultRecord:async(id:string,v:unknown)=>{m.write(id,v);m.records.set(id,v);},
}));
vi.mock('../libsignalStoreLock',()=>({withLibsignalStoreLock:(_u:string,_d:string,work:()=>unknown)=>work()}));
vi.mock('@/lib/device-manager/deviceFinalizationTrace',async(original)=>({
  ...await original<typeof import('@/lib/device-manager/deviceFinalizationTrace')>(),
  traceFinalizationOperation:(_s:string,work:()=>unknown)=>work(),
}));
import { generateIdentityKeys,exportPublicKeyBundle } from '../keyManager';
import { signDeviceAuthorization } from '../deviceIdentity';
import { signLibsignalBundleBinding } from '../libsignalBundleBinding';
import { decryptFromLibsignalDevice } from '../libsignalRuntime';
import { __libsignalDeviceNumberTest } from '../libsignalDeviceNumber';
import type { LibsignalReceiveProof } from '../libsignalReceiveBinding';
const owner={ownerUserId:'bob',ownerDeviceId:'ios',remoteUserId:'alice',remoteDeviceId:'pc'};
const storeId='aegis.libsignal.store:bob:ios';
const unpack=(bytes:Uint8Array)=>{const parts:Uint8Array[]=[];let i=0;while(i<bytes.length){const n=new DataView(bytes.buffer,bytes.byteOffset+i,4).getUint32(0,true);i+=4;parts.push(bytes.slice(i,i+n));i+=n;}return parts;};
let proof:LibsignalReceiveProof;let alice:Uint8Array;let bobBundle:Uint8Array;
beforeAll(async()=>{await wasm.default({module_or_path:readFileSync('src/lib/crypto/wasm/generated/aegis_crypto_bg.wasm')});});
beforeEach(async()=>{
  vi.clearAllMocks();vi.stubGlobal('window',Object.assign(new EventTarget(),{isSecureContext:true}));
  m.records.clear();m.write.mockReset();m.trust.mockResolvedValue(undefined);__libsignalDeviceNumberTest.reset();
  const account=await generateIdentityKeys();const pub=await exportPublicKeyBundle(account);
  const signing=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
  const kx=await crypto.subtle.generateKey('X25519',true,['deriveBits']) as CryptoKeyPair;
  const raw=async(key:CryptoKey)=>Buffer.from(await crypto.subtle.exportKey('raw',key)).toString('base64');
  const [initial,bundle]=unpack(await wasm.aegis_wasm_bundle_create(wasm.aegis_wasm_store_create(101),1,21,22,23));
  const [bob,bundleB]=unpack(await wasm.aegis_wasm_bundle_create(wasm.aegis_wasm_store_create(202),2,11,12,13));bobBundle=bundleB;
  m.records.set(storeId,{bytes:Buffer.from(bob).toString('base64')});
  const devicePublicKey=await raw(kx.publicKey),deviceSigningKey=await raw(signing.publicKey);
  const ctx={userId:'alice',deviceId:'pc',deviceNumber:1,registrationId:101,publicBundle:Buffer.from(bundle).toString('base64')};
  proof={...ctx,signature:await signLibsignalBundleBinding(ctx,signing.privateKey),devicePublicKey,deviceSigningKey,
    deviceAuthorizationSignature:await signDeviceAuthorization({userId:'alice',deviceId:'pc',accountFingerprint:pub.fingerprint,
      devicePublicKey,deviceSigningKey,accountSigningPrivateKey:account.signingPrivateKey}),
    accountIdentityKey:pub.identityKey,accountSigningKey:pub.signingKey,accountFingerprint:pub.fingerprint,
    accountBindingSignature:pub.bindingSignature,accountBindingVersion:pub.bindingVersion};
  alice=await wasm.aegis_wasm_session_establish(initial,'alice',1,'bob',2,bobBundle);
  m.rpc.mockImplementation((name:string)=>{
    if(name==='get_libsignal_device_number')return {abortSignal:async()=>({data:2,error:null})};
    if(name==='get_libsignal_receive_attestation')return Promise.resolve({data:proof,error:null});
    throw new Error(`unexpected RPC ${name}`);
  });
});
afterEach(()=>vi.unstubAllGlobals());
async function send(text:string){const [next,type,cipher]=unpack(await wasm.aegis_wasm_message_encrypt(alice,'alice',1,'bob',2,new TextEncoder().encode(text)));alice=next;return `aegis.libsignal.${type[0]}.${Buffer.from(cipher).toString('base64')}`;}
const receive=(payload:string)=>decryptFromLibsignalDevice({...owner,payload});
it('verifies the entire real account/device/bundle chain before first and warm decryption',async()=>{
  for(const text of ['Bonjour 👋','Vocal: capsule','Suite'])expect(await receive(await send(text))).toBe(text);
  expect(m.rpc.mock.calls.filter(([n])=>n==='get_libsignal_receive_attestation')).toHaveLength(1);
  expect(m.rpc.mock.calls.some(([n])=>n==='claim_libsignal_prekey_bundle')).toBe(false);
  expect(m.trust).toHaveBeenCalledWith('bob','alice',proof.accountFingerprint);
});
it('keeps delayed historical messages decryptable without querying the active sender registry',async()=>{
  const delayed=await send('ancien');const newer=await send('récent');
  expect(await receive(newer)).toBe('récent');
  m.rpc.mockImplementation(()=>{throw new Error('sender offline or revoked');});
  expect(await receive(delayed)).toBe('ancien');
});
it('refuses a forged first sender without consuming the legitimate prekey',async()=>{
  const original=m.records.get(storeId);const real=alice;
  alice=await wasm.aegis_wasm_session_establish(wasm.aegis_wasm_store_create(999),'alice',1,'bob',2,bobBundle);
  await expect(receive(await send('impostor'))).rejects.toThrow();
  expect(m.records.get(storeId)).toEqual(original);
  alice=real;expect(await receive(await send('legitimate'))).toBe('legitimate');
});
it.each(['signature','deviceAuthorizationSignature','accountBindingSignature'] as const)('refuses altered %s before store mutation',async(field)=>{
  const before=m.records.get(storeId);proof={...proof,[field]:'A'.repeat(88)};
  await expect(receive(await send('no'))).rejects.toThrow(/BINDING_INVALID/);
  expect(m.records.get(storeId)).toEqual(before);expect(m.write).not.toHaveBeenCalled();
});
it.each([{userId:'mallory'},{deviceId:'other'},{deviceNumber:3},{registrationId:999}])('refuses proof substitution %o',async(change)=>{
  const before=m.records.get(storeId);proof={...proof,...change};
  await expect(receive(await send('no'))).rejects.toThrow(/BINDING_INVALID/);expect(m.records.get(storeId)).toEqual(before);
});
it('does not mutate the ratchet when public proof persistence fails and can retry the same message',async()=>{
  const before=m.records.get(storeId);const message=await send('retry me');m.write.mockImplementationOnce(()=>{throw new Error('vault full');});
  await expect(receive(message)).rejects.toThrow('vault full');expect(m.records.get(storeId)).toEqual(before);
  expect(await receive(message)).toBe('retry me');
});
it('refuses unavailable proof instead of reverting to trust on first use',async()=>{
  const before=m.records.get(storeId);
  m.rpc.mockImplementation((name:string)=>name==='get_libsignal_device_number'?{abortSignal:async()=>({data:2,error:null})}:Promise.resolve({data:null,error:null}));
  await expect(receive(await send('no'))).rejects.toThrow('RECEIVE_PROOF_UNAVAILABLE');expect(m.records.get(storeId)).toEqual(before);
});
it('refuses a locally known account fingerprint change before decrypting',async()=>{
  const before=m.records.get(storeId);m.trust.mockRejectedValueOnce(new Error('FINGERPRINT_CHANGED'));
  await expect(receive(await send('no'))).rejects.toThrow('FINGERPRINT_CHANGED');expect(m.records.get(storeId)).toEqual(before);
});
