import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { liveArchiveKey } from './live-policy.ts';

const MEDIA_REFERENCES = [
  ['posts','image_url'],['posts','media_thumbnail_url'],['profiles','avatar_url'],['profiles','cover_url'],
  ['albums','cover_url'],['album_media','media_url'],['ad_campaigns','image_url'],['ad_campaigns','video_url'],
  ['challenges','image_url'],['challenge_submissions','image_url'],['groups','cover_image_url'],['group_posts','image_url'],
  ['messages','image_url'],['messages','document_url'],['products','thumbnail_url'],['stories','image_url'],
  ['ads','image_url'],['ads','video_url'],['short_videos','video_url'],['short_videos','thumbnail_url'],
] as const;

export async function removeLiveArchiveAsset(db: SupabaseClient, raw: string, owner: string, liveId: string): Promise<void> {
  const key = liveArchiveKey(raw, Deno.env.get('R2_PUBLIC_URL') ?? '', owner);
  // A deliberately shared post/reel is a separate publication and survives the archive.
  // Fail closed if any reference lookup fails; never guess that a file is orphaned.
  for (const [table,column] of MEDIA_REFERENCES) {
    const { count,error } = await db.from(table).select('id',{count:'exact',head:true}).eq(column,raw);
    if (error) throw new Error('LIVE_ARCHIVE_REFERENCE_LOOKUP_FAILED');
    if (count) return;
  }
  const { count: productCount, error: productError } = await db.from('products').select('id',{count:'exact',head:true}).contains('images',[raw]);
  if (productError) throw new Error('LIVE_ARCHIVE_REFERENCE_LOOKUP_FAILED');
  if (productCount) return;
  for (const column of ['recording_url','thumbnail_url']) {
    const { count,error } = await db.from('live_streams').select('id',{count:'exact',head:true}).neq('id',liveId).eq(column,raw)
      .or(`is_active.eq.true,archive_expires_at.gt.${new Date().toISOString()}`);
    if (error) throw new Error('LIVE_ARCHIVE_REFERENCE_LOOKUP_FAILED');
    if (count) return;
  }
  const account = Deno.env.get('R2_ACCOUNT_ID') ?? '';
  const bucket = Deno.env.get('R2_BUCKET_NAME') ?? '';
  let access = Deno.env.get('R2_ACCESS_KEY_ID') ?? '';
  let secret = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? '';
  if (access.length === 64 && secret.length === 32) [access,secret] = [secret,access];
  if (!account || !bucket || !access || !secret) throw new Error('LIVE_ARCHIVE_STORAGE_UNCONFIGURED');
  const region = Deno.env.get('R2_REGION');
  const host = `${account}.${region ? region + '.' : ''}r2.cloudflarestorage.com`;
  const path = `/${bucket}/${key}`;
  const date = new Date().toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';
  const day = date.slice(0,8), scope = `${day}/auto/s3/aws4_request`;
  const encoder = new TextEncoder();
  const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes)).map(b=>b.toString(16).padStart(2,'0')).join('');
  const hash = async (text: string) => hex(await crypto.subtle.digest('SHA-256',encoder.encode(text)));
  const hmac = async (key: Uint8Array, text: string): Promise<Uint8Array> => {
    const imported = await crypto.subtle.importKey('raw',new Uint8Array(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC',imported,encoder.encode(text)));
  };
  const empty = await hash('');
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = ['DELETE',path,'',`host:${host}\nx-amz-content-sha256:${empty}\nx-amz-date:${date}\n`,signedHeaders,empty].join('\n');
  let signingKey = await hmac(encoder.encode(`AWS4${secret}`),day);
  for (const part of ['auto','s3','aws4_request']) signingKey = await hmac(signingKey,part);
  const signatureBytes = await hmac(signingKey,`AWS4-HMAC-SHA256\n${date}\n${scope}\n${await hash(canonical)}`);
  const signature = Array.from(signatureBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
  const response = await fetch(`https://${host}${path}`,{method:'DELETE',headers:{
    'x-amz-content-sha256':empty,'x-amz-date':date,
    Authorization:`AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }});
  if (!response.ok && response.status !== 404) throw new Error('LIVE_ARCHIVE_STORAGE_DELETE_FAILED');
}
