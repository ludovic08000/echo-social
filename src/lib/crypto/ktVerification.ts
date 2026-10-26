import {buildMerkleTree,signedHeadBytes} from './ktMerkle';

export interface TransparencyHead {
  epoch:number|string;leaf_count:number;prev_epoch:number|string|null;
  root_hash:string;signing_key_id:string;signature:string;
}
export type TrustedTransparencyKeys=Readonly<Record<string,JsonWebKey>>;
export type HeadVerification='verified'|'untrusted_authority'|'invalid_head'|'invalid_signature'|'verification_unavailable';
const HEX=/^[0-9a-f]{64}$/;
const epoch=(value:unknown):bigint|null=>{
  if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<1))return null;
  if(typeof value!=='number'&&(typeof value!=='string'||!/^[1-9][0-9]{0,15}$/.test(value)))return null;
  const parsed=BigInt(value);return parsed<=9007199254740991n?parsed:null;
};
const validPublicKey=(key:JsonWebKey|undefined):key is JsonWebKey=>Boolean(key&&key.kty==='OKP'&&key.crv==='Ed25519'
  &&typeof key.x==='string'&&/^[A-Za-z0-9_-]{43}$/.test(key.x)&&!('d' in key));

/** Les clés viennent de la configuration de livraison, jamais du serveur que l'on vérifie. */
export function configuredTransparencyKeys(serialized:unknown):TrustedTransparencyKeys {
  if(typeof serialized!=='string'||serialized.length>20_000)return {};
  try {
    const value=JSON.parse(serialized);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>10)return {};
    const result:Record<string,JsonWebKey>={};
    for(const [id,key] of Object.entries(value)){
      if(!/^[a-zA-Z0-9-]{1,100}$/.test(id)||!validPublicKey(key as JsonWebKey))return {};
      const publicKey=key as JsonWebKey;
      result[id]={kty:'OKP',crv:'Ed25519',x:publicKey.x};
    }
    return result;
  } catch { return {}; }
}

export async function verifyTransparencyHead(head:TransparencyHead,keys:TrustedTransparencyKeys):Promise<HeadVerification> {
  const current=epoch(head?.epoch),previous=head?.prev_epoch===null?null:epoch(head?.prev_epoch);
  if(current===null||!Number.isSafeInteger(head.leaf_count)||head.leaf_count<1||head.leaf_count>5000
    ||!HEX.test(head.root_hash)||!/^[0-9a-f]{128}$/.test(head.signature)
    ||(current===1n?head.prev_epoch!==null:previous!==current-1n))return 'invalid_head';
  const pinned=Object.prototype.hasOwnProperty.call(keys,head.signing_key_id)?keys[head.signing_key_id]:undefined;
  if(!validPublicKey(pinned))return 'untrusted_authority';
  try {
    const key=await crypto.subtle.importKey('jwk',pinned,{name:'Ed25519'},false,['verify']);
    const signature=Uint8Array.from(head.signature.match(/../g)!,byte=>parseInt(byte,16));
    const bytes=signedHeadBytes(current,head.root_hash,head.leaf_count,previous);
    return await crypto.subtle.verify('Ed25519',key,signature,new Uint8Array(bytes))?'verified':'invalid_signature';
  } catch { return 'verification_unavailable'; }
}

export async function verifyTransparencyBatch(head:TransparencyHead,leaves:readonly {leaf_index:number;leaf_hash:string}[]):Promise<boolean> {
  if(!Number.isSafeInteger(head.leaf_count)||head.leaf_count<1||head.leaf_count>5000||leaves.length!==head.leaf_count)return false;
  if(leaves.some((leaf,index)=>!leaf||leaf.leaf_index!==index||!HEX.test(leaf.leaf_hash)))return false;
  return (await buildMerkleTree(leaves.map(leaf=>leaf.leaf_hash))).root===head.root_hash;
}

export interface TransparencyCheckpoint {epoch:number|string;root_hash:string}
export function transparencyCheckpointConflict(head:TransparencyHead,checkpoint:TransparencyCheckpoint|null):boolean {
  const current=epoch(head.epoch),previous=checkpoint?epoch(checkpoint.epoch):null;
  if(!checkpoint||previous===null||!HEX.test(checkpoint.root_hash))return false;
  return current===null||current<previous||(current===previous&&head.root_hash!==checkpoint.root_hash);
}
