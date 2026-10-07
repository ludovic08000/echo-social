// Validates locally by default. --upload requires an operator-created PRIVATE bucket
// and an explicit free-capacity budget; never creates billing resources or activates geo.
import { readFile, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const directory = args.find(arg => !arg.startsWith('--'));
if (!directory || args.includes('--help')) {
  console.log('node scripts/geoip/upload-dbip-lite.mjs <release-directory> [--upload --max-bytes=N]');
  console.log('Without --upload: local verification only. No network access.');
  process.exit(args.includes('--help') ? 0 : 1);
}
const root = resolve(directory);
const release = basename(root);
if (!/^\d{4}-(0[1-9]|1[0-2])-[a-f0-9]{12}$/.test(release)) throw Error('INVALID_RELEASE_DIRECTORY');
const digest = b => createHash('sha256').update(b).digest('hex');
const manifestBytes = await readFile(resolve(root, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
if (manifest.format !== 'forsure-dbip-lite' || manifestBytes.length > 8_388_608
  || !Number.isSafeInteger(manifest.databaseEpoch) || Date.now() - manifest.databaseEpoch * 1000 > 100 * 86_400_000
  || manifest.databaseEpoch * 1000 > Date.now() + 86_400_000
  || `${manifest.edition}-${(manifest.buildSha256 ?? manifest.sourceSha256)?.slice(0, 12)}` !== release) throw Error('INVALID_OR_STALE_MANIFEST');
const hashes = new Set();
for (const family of ['4', '6']) {
  const rows = manifest.ranges?.[family];
  if (!Array.isArray(rows) || rows.length > 60_000) throw Error('INVALID_MANIFEST_RANGES');
  for (const row of rows) {
    if (!Array.isArray(row) || !/^[a-f0-9]{64}$/.test(row[2])) throw Error('INVALID_SHARD');
    hashes.add(row[2]);
  }
}
if (!hashes.size) throw Error('EMPTY_RELEASE');
let total = manifestBytes.length;
for (const hash of hashes) {
  const path = resolve(root, `${hash}.json`);
  if ((await stat(path)).size > 262_144) throw Error('SHARD_TOO_LARGE');
  const contents = await readFile(path);
  if (digest(contents) !== hash) throw Error('SHARD_CHECKSUM_FAILED');
  total += contents.length;
}
console.log(JSON.stringify({ release, files: hashes.size + 1, bytes: total, manifestSha256: digest(manifestBytes) }));
if (!args.includes('--upload')) process.exit(0);
const budget = Number(args.find(arg => arg.startsWith('--max-bytes='))?.split('=')[1]);
if (!Number.isSafeInteger(budget) || budget < total || budget <= 0) throw Error('CONFIRMED_FREE_CAPACITY_REQUIRED');
const key = process.env.LOVABLE_CLOUD_SERVICE_ROLE_KEY;
if (!key) throw Error('SERVER_CREDENTIAL_REQUIRED');
// Fixed existing project. Credentials never sent to an argument-supplied endpoint.
const client = createClient('https://vkpmoqfzrihcijjochks.supabase.co', key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) }) },
});
const { data: bucket, error } = await client.storage.getBucket('geoip-lite');
if (error || !bucket || bucket.public) throw Error('PRIVATE_BUCKET_REQUIRED');
const storage = client.storage.from('geoip-lite');
for (const file of [...hashes].map(h => `${h}.json`).concat('manifest.json')) {
  const content = await readFile(resolve(root, file));
  // No overwrite. Upload manifest LAST. An interrupted release is never auto-enabled.
  const result = await storage.upload(`${release}/${file}`, content, { contentType: 'application/json', upsert: false, cacheControl: '31536000' });
  if (result.error) {
    // Idempotent resume only for a conflict, after checking exact existing bytes.
    if (!['409', 'Duplicate', 'ResourceAlreadyExists'].includes(String(result.error.statusCode ?? result.error.code))) throw Error('UPLOAD_FAILED');
    const existing = await storage.download(`${release}/${file}`);
    if (existing.error || !existing.data || digest(Buffer.from(await existing.data.arrayBuffer())) !== digest(content)) throw Error('REMOTE_OBJECT_MISMATCH');
  }
}
console.log('Private release uploaded; DBIP_LITE_ENABLED and deployment unchanged. Validate before activation.');
