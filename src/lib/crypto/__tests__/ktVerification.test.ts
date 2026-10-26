// @vitest-environment node
import {beforeAll,expect,it} from 'vitest';
import {buildMerkleTree,leafHash,signedHeadBytes} from '../ktMerkle';
import {configuredTransparencyKeys,transparencyCheckpointConflict,verifyTransparencyBatch,verifyTransparencyHead,type TransparencyHead} from '../ktVerification';
let key:CryptoKeyPair;let pub:JsonWebKey;let head:TransparencyHead;let leaves:{leaf_index:number;leaf_hash:string}[];
beforeAll(async()=>{
  key=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
  pub=await crypto.subtle.exportKey('jwk',key.publicKey);
  leaves=await Promise.all([0,1,2].map(async leaf_index=>({leaf_index,leaf_hash:await leafHash('entry-'+leaf_index)})));
  const root=(await buildMerkleTree(leaves.map(leaf=>leaf.leaf_hash))).root;
  const signature=Buffer.from(await crypto.subtle.sign('Ed25519',key.privateKey,new Uint8Array(signedHeadBytes(2,root,3,1)))).toString('hex');
  head={epoch:2,leaf_count:3,prev_epoch:1,root_hash:root,signing_key_id:'operator-key',signature};
});
it('verifies the real Ed25519 signature and complete historical Merkle batch',async()=>{
  expect(await verifyTransparencyHead(head,{'operator-key':pub})).toBe('verified');
  expect(await verifyTransparencyBatch(head,leaves)).toBe(true);
});
it('never trusts a key supplied only by the same database or an absent/invalid configuration',async()=>{
  expect(await verifyTransparencyHead(head,{})).toBe('untrusted_authority');
  expect(configuredTransparencyKeys('bad')).toEqual({});
  expect(configuredTransparencyKeys(JSON.stringify({'operator-key':{...pub,d:'SECRET'}}))).toEqual({});
  expect(configuredTransparencyKeys(JSON.stringify({'operator-key':pub}))).toEqual({'operator-key':{kty:'OKP',crv:'Ed25519',x:pub.x}});
});
it('rejects a substituted authority or forged signature without changing any device identity',async()=>{
  const other=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
  expect(await verifyTransparencyHead(head,{'operator-key':await crypto.subtle.exportKey('jwk',other.publicKey)})).toBe('invalid_signature');
  expect(await verifyTransparencyHead({...head,signature:'00'.repeat(64)},{'operator-key':pub})).toBe('invalid_signature');
});
it('rejects unsafe integers, impossible previous epochs and changed counts/roots',async()=>{
  for(const invalid of [{epoch:Number.MAX_SAFE_INTEGER+1},{prev_epoch:null},{leaf_count:0},{root_hash:'zz'.repeat(32)}]){
    expect(await verifyTransparencyHead({...head,...invalid},{'operator-key':pub})).toBe('invalid_head');
  }
  expect(await verifyTransparencyHead({...head,root_hash:'ab'.repeat(32)},{'operator-key':pub})).toBe('invalid_signature');
});
it('rejects missing, duplicated, reordered or forged leaves',async()=>{
  for(const changed of [leaves.slice(1),[leaves[1],leaves[0],leaves[2]],[leaves[0],leaves[0],leaves[2]],leaves.map(leaf=>({...leaf,leaf_hash:'00'.repeat(32)}))]){
    expect(await verifyTransparencyBatch(head,changed)).toBe(false);
  }
});
it('detects rollback and same-epoch equivocation against an already verified local checkpoint',()=>{
  expect(transparencyCheckpointConflict(head,{epoch:3,root_hash:head.root_hash})).toBe(true);
  expect(transparencyCheckpointConflict(head,{epoch:2,root_hash:'00'.repeat(32)})).toBe(true);
  expect(transparencyCheckpointConflict(head,{epoch:2,root_hash:head.root_hash})).toBe(false);
  expect(transparencyCheckpointConflict(head,null)).toBe(false);
});
