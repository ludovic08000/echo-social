// Offline validation by default. --apply imports a licensed partner batch into Lovable Cloud.
// Never fetch arbitrary RSS URLs, execute publisher HTML or auto-approve a license/content.
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function validateMediaBatch(partner, items) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(partner)) throw new Error('Invalid partner ID');
  if (!Array.isArray(items) || !items.length || items.length>50 || Buffer.byteLength(JSON.stringify(items))>200_000) throw new Error('Batch requires 1–50 items, at most 200KB');
  const keys=['external_id','title','excerpt','canonical_url','kind','youtube_id','published_at','expires_at'];
  const unique=new Set();
  for(const item of items){
    if (!item || typeof item!=='object' || Object.keys(item).some(k=>!keys.includes(k)) || Object.values(item).some(v=>v!==null && typeof v!=='string')) throw new Error('Invalid item fields');
    for(const [key,max] of [['external_id',200],['title',220],['canonical_url',2048]]) if (!item[key]?.trim() || item[key].length>max) throw new Error(`Invalid ${key}`);
    if (unique.has(item.external_id)) throw new Error('Duplicate external ID'); unique.add(item.external_id);
    const url=new URL(item.canonical_url);
    if (url.protocol!=='https:' || url.username || url.password || Array.from(item.canonical_url).some(char=>char.charCodeAt(0)<32 || char==='\\' || char.charCodeAt(0)===127)) throw new Error('Invalid canonical URL');
    if (!['article','video'].includes(item.kind) || (item.excerpt?.length??0)>400) throw new Error('Invalid format or excerpt');
    if (item.youtube_id && (item.kind!=='video' || !/^[A-Za-z0-9_-]{11}$/.test(item.youtube_id))) throw new Error('Invalid video ID');
    if (!Number.isFinite(Date.parse(item.published_at)) || !Number.isFinite(Date.parse(item.expires_at)) || Date.parse(item.expires_at)<=Date.parse(item.published_at)) throw new Error('Invalid publication/expiry');
  }
  return items;
}
async function main(){
  const [partner,file,mode,...extra]=process.argv.slice(2);
  if (!partner || !file || (mode && mode!=='--apply') || extra.length) throw new Error('Usage: node scripts/import-partner-media.mjs PARTNER_UUID FILE.json [--apply]');
  if (statSync(file).size>200_000) throw new Error('Input too large');
  const items=validateMediaBatch(partner,JSON.parse(readFileSync(file,'utf8')));
  if (!mode) { console.log(`Validated ${items.length} items locally. No upload. Server will also check configured rights and publisher hostname.`); return; }
  const token=process.env.FORSURE_CLOUD_SERVICE_ROLE_KEY;
  if (!token) throw new Error('FORSURE_CLOUD_SERVICE_ROLE_KEY must be supplied securely for --apply');
  const response=await fetch('https://vkpmoqfzrihcijjochks.supabase.co/rest/v1/rpc/import_partner_media',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
    headers:{apikey:token,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({p_partner:partner,p_items:items}),
  });
  if (!response.ok) throw new Error(`Lovable import rejected (HTTP ${response.status}); check configured rights and migration. No automatic retry.`);
  console.log(`Imported ${await response.json()} new/changed items. Review and approval still required before feed visibility.`);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
