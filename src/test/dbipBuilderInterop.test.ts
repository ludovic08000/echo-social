import { execFileSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDbipLookup } from '../../supabase/functions/_shared/dbip-lite';

it('reads real Python-generated shards in the Edge reader and validates the offline upload manifest', async () => {
  const tempRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(tempRoot, 'forsure-geo-interop-'));
  try {
    vi.stubGlobal('crypto', webcrypto);
    const code = `import sys\nsys.path.insert(0, 'scripts/geoip')\nfrom build_dbip_lite import build\nfrom test_build_dbip_lite import record\nimport time\nprint(build([('8.8.8.0/24', record('Reims')), ('2001:4860::/32', record('東京'))], sys.argv[1], '2026-10', int(time.time()), 'a'*64)['release'])`;
    const release = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', code, directory], { encoding: 'utf8', timeout: 15_000 }).trim();
    const root = join(directory, release);
    const manifest = readFileSync(join(root, 'manifest.json'));
    const read = vi.fn(async (file: string) => new Uint8Array(readFileSync(join(root, file))));
    const lookup = createDbipLookup({ read, manifestSha256: createHash('sha256').update(manifest).digest('hex') });
    expect(await lookup('8.8.8.8', 'fr')).toMatchObject({ country: 'FR', region: 'Grand Est', city: 'Reims', display: { country: 'France-fr' } });
    expect((await lookup('2001:4860::8888', 'ja'))?.display.city).toBe('東京');
    const stdout = execFileSync(process.execPath, ['scripts/geoip/upload-dbip-lite.mjs', root], { encoding: 'utf8', timeout: 15_000 });
    expect(JSON.parse(stdout)).toMatchObject({ release, files: 3, manifestSha256: createHash('sha256').update(manifest).digest('hex') });
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
    // Delete only this test's freshly allocated directory, never an unresolved/broad path.
    const owned = realpathSync(directory);
    const rel = relative(tempRoot, owned);
    if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('forsure-geo-interop-') || resolve(owned) === tempRoot) throw Error('UNSAFE_TEST_CLEANUP');
    rmSync(owned, { recursive: true });
  }
}, 30_000);
