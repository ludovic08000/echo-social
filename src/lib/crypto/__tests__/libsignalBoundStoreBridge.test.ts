// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ native:false, platform:'ios', capable:true, locked:false,
  read:vi.fn(), write:vi.fn(), bind:vi.fn(), encrypt:vi.fn(), decrypt:vi.fn(), record:{bytes:'AQ=='} }));
function pack(parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((n,p) => n+4+p.length,0)); let offset=0;
  for (const part of parts) { new DataView(output.buffer).setUint32(offset,part.length,true); offset+=4; output.set(part,offset); offset+=part.length; }
  return output;
}
vi.mock('@capacitor/core', () => ({ Capacitor:{getPlatform:()=>m.platform}, registerPlugin:()=>({
  getCapabilities:async()=>({available:true,platform:m.platform,abiVersion:1,identityBinding:m.capable}),
  bindIdentity:async(args: {storeB64:string})=>{ await m.bind(args.storeB64); return {storeB64:'Ag=='}; },
  encrypt:async(args: {storeB64:string})=>{ await m.encrypt(args.storeB64); return {storeB64:'Aw==',messageType:2,ciphertextB64:'BA=='}; },
  decrypt:async(args: {storeB64:string})=>{ await m.decrypt(args.storeB64); return {storeB64:'Aw==',plaintextB64:'BQ=='}; },
}) }));
vi.mock('../wasm/generated/aegis_crypto.js', () => ({ default:async()=>undefined, aegis_wasm_abi_version:()=>1,
  aegis_wasm_identity_bind:async(store: Uint8Array)=>{ await m.bind(Buffer.from(store).toString('base64')); return Uint8Array.of(2); },
  aegis_wasm_message_encrypt:async(store: Uint8Array)=>{ await m.encrypt(Buffer.from(store).toString('base64')); return pack([Uint8Array.of(3),Uint8Array.of(2),Uint8Array.of(4)]); },
  aegis_wasm_message_decrypt:async(store: Uint8Array)=>{ await m.decrypt(Buffer.from(store).toString('base64')); return pack([Uint8Array.of(3),Uint8Array.of(5)]); },
}));
vi.mock('@/lib/runtimePlatform',()=>({isVerifiedNativeRuntime:()=>m.native}));
vi.mock('../deviceVault',()=>({readDeviceVaultRecord:m.read,writeDeviceVaultRecord:m.write}));
vi.mock('../libsignalStoreLock',()=>({withLibsignalStoreLock:async(_u:string,_d:string,work:()=>Promise<unknown>)=>{
  expect(m.locked).toBe(false); m.locked=true; try{return await work();}finally{m.locked=false;}
}}));
vi.mock('@/lib/device-manager/deviceFinalizationTrace',()=>({traceFinalizationOperation:(_s:string,work:()=>unknown)=>work()}));
const args = {ownerUserId:'alice',ownerDeviceId:'phone',local:{userId:'alice',deviceNumber:1},remote:{userId:'bob',deviceNumber:2},
  verifiedRemoteIdentity:new Uint8Array([5,...new Uint8Array(32)]),plaintext:Uint8Array.of(5),encrypted:{messageType:2,ciphertext:Uint8Array.of(4)}};
async function run(operation: 'encrypt'|'decrypt') {
  const bridge = await import('../libsignalPlatformBridge');
  return operation==='encrypt' ? bridge.encryptLibsignalMessage(args) : bridge.decryptLibsignalMessage(args);
}
describe.each(['wasm','ios','android'])('bound store transaction on %s',platform=>{
  beforeEach(()=>{
    vi.resetModules(); vi.resetAllMocks(); vi.stubGlobal('window',{isSecureContext:true});
    m.native=platform!=='wasm'; m.platform=platform; m.capable=true; m.locked=false; m.record={bytes:'AQ=='};
    m.read.mockImplementation(async()=>m.record);
    m.write.mockImplementation(async(_id:string,record:{bytes:string})=>{ expect(m.locked).toBe(true); m.record=record; });
    m.bind.mockImplementation(async()=>{expect(m.locked).toBe(true);});
  });
  afterEach(()=>vi.unstubAllGlobals());
  it.each(['encrypt','decrypt'] as const)('pins before %s, commits only final store and checks readback',async op=>{
    await run(op);
    expect(m.bind).toHaveBeenCalledWith('AQ==');
    expect(m[op]).toHaveBeenCalledWith('Ag==');
    expect(m.bind.mock.invocationCallOrder[0]).toBeLessThan(m[op].mock.invocationCallOrder[0]);
    expect(m.write).toHaveBeenCalledOnce();
    expect(m.record.bytes).toBe('Aw==');
    expect(m.read).toHaveBeenCalledTimes(2);
    expect(m.locked).toBe(false);
  });
  it.each(['encrypt','decrypt'] as const)('rejects binding failure before %s or persistence',async op=>{
    m.bind.mockRejectedValue(new Error('untrusted remote identity: private details'));
    await expect(run(op)).rejects.toThrow('AEGIS_LIBSIGNAL_IDENTITY_BINDING_INVALID');
    expect(m[op]).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled();
    expect(m.record.bytes).toBe('AQ=='); expect(m.locked).toBe(false);
  });
  it.each(['encrypt','decrypt'] as const)('does not persist the intermediate pin after %s failure',async op=>{
    m[op].mockRejectedValue(new Error('invalid ciphertext or session'));
    await expect(run(op)).rejects.toThrow('invalid ciphertext or session');
    expect(m.write).not.toHaveBeenCalled(); expect(m.record.bytes).toBe('AQ==');
  });
  it.each(['encrypt','decrypt'] as const)('does not release the %s result after failed readback',async op=>{
    m.read.mockResolvedValue({bytes:'AQ=='});
    await expect(run(op)).rejects.toThrow('STORE_COMMIT_FAILED');
  });
  if(platform!=='wasm') it.each(['encrypt','decrypt'] as const)('requires updated native support for %s without falling back',async op=>{
    m.capable=false;
    await expect(run(op)).rejects.toThrow('AEGIS_CLIENT_UPDATE_REQUIRED');
    expect(m.bind).not.toHaveBeenCalled(); expect(m[op]).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled();
  });
});
