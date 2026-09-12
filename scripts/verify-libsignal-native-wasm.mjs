/** Cross-engine protocol test: real native C ABI and the shipped browser WASM. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import init, * as w from '../src/lib/crypto/wasm/generated/aegis_crypto.js';
const library = process.argv[2];
assert.ok(library, 'Pass the compiled native shared library path');
await init({ module_or_path: await readFile(new URL('../src/lib/crypto/wasm/generated/aegis_crypto_bg.wasm', import.meta.url)) });
function unpack(bytes, count) {
  let offset = 0; const parts = [];
  for (let i=0;i<count;i++) { const n=new DataView(bytes.buffer,bytes.byteOffset+offset,4).getUint32(0,true); offset+=4; parts.push(bytes.slice(offset,offset+n)); offset+=n; }
  assert.equal(offset,bytes.length); return parts;
}
function native(op, bytes=[], local='', remote='', type=0) {
  const result=spawnSync('python',['scripts/libsignal-native-test-bridge.py',library], {
    input: JSON.stringify({op,bytes:bytes.map(b=>Buffer.from(b).toString('base64')),local,remote,type}), encoding:'utf8',timeout:10000,
  });
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout).map(b=>new Uint8Array(Buffer.from(b,'base64')));
}
const engines = {
  native: {
    create:()=>native('store_create')[0], bundle:s=>native('bundle_create',[s]),
    establish:(s,l,r,b)=>native('session_establish',[s,b],l,r)[0],
    encrypt:(s,l,r,b)=>native('message_encrypt',[s,b],l,r),
    decrypt:(s,l,r,t,b)=>native('message_decrypt',[s,b],l,r,t),
  },
  wasm: {
    create:()=>w.aegis_wasm_store_create(43),
    bundle:async s=>unpack(await w.aegis_wasm_bundle_create(s,1,11,12,13),2),
    establish:(s,l,r,b)=>w.aegis_wasm_session_establish(s,l,1,r,1,b),
    encrypt:async(s,l,r,b)=>unpack(await w.aegis_wasm_message_encrypt(s,l,1,r,1,b),3),
    decrypt:async(s,l,r,t,b)=>unpack(await w.aegis_wasm_message_decrypt(s,l,1,r,1,t,b),2),
  },
};
for(const [start,receive] of [['native','wasm'],['wasm','native']]) {
  const a=engines[start],b=engines[receive]; let as=a.create(),bs=b.create();
  let bundle; [bs,bundle]=await b.bundle(bs); as=await a.establish(as,'alice','bob',bundle);
  for(let i=0;i<3;i++) {
    const text=new TextEncoder().encode(`Bonjour interop 👋 ${i}`);
    let type,cipher,clear; [as,type,cipher]=await a.encrypt(as,'alice','bob',text);
    [bs,clear]=await b.decrypt(bs,'bob','alice',type[0],cipher); assert.deepEqual(clear,text);
    [bs,type,cipher]=await b.encrypt(bs,'bob','alice',text);
    [as,clear]=await a.decrypt(as,'alice','bob',type[0],cipher); assert.deepEqual(clear,text);
  }
  console.log(`PASS ${start} initiates → ${receive}, 3 real bidirectional round trips`);
}
console.log('Native/WASM protocol interop passed; this does not test iOS/Android UI or production transport.');
