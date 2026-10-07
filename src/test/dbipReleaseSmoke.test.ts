import { execFileSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDbipLookup, DBIP_LANGUAGES } from '../../supabase/functions/_shared/dbip-lite';

// Opt-in, offline only: the licensed monthly database must never enter Git/CI fixtures.
const release = process.env.DBIP_TEST_RELEASE;
const database = process.env.DBIP_TEST_DATABASE;
it.runIf(Boolean(release && database))('matches the original City Lite MMDB through the production reader in all ten languages', async () => {
  const python = process.env.DBIP_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const samples = ['8.8.8.8', '1.1.1.1', '51.38.0.1', '2001:4860::8888', '2606:4700::1111'];
  const code = 'import json,sys,maxminddb\nwith maxminddb.open_database(sys.argv[1],mode=maxminddb.MODE_AUTO) as db:\n print(json.dumps([db.get(ip) for ip in json.loads(sys.argv[2])]))';
  type RecordNames = { names?: Record<string, string>; iso_code?: string };
  const records = JSON.parse(execFileSync(python, ['-c', code, database!, JSON.stringify(samples)], { encoding: 'utf8', timeout: 30_000 })) as Array<{
    country: RecordNames; subdivisions?: RecordNames[]; city?: RecordNames;
  }>;
  const fallback = (values: Record<string, string> | undefined, language: string) => {
    const names = values ?? {};
    return names[language] ?? names.en ?? names.fr ?? DBIP_LANGUAGES.map(l => names[l]).find(Boolean) ?? null;
  };
  vi.stubGlobal('crypto', webcrypto);
  try {
    const manifest = readFileSync(join(release!, 'manifest.json'));
    const lookup = createDbipLookup({
      read: async file => new Uint8Array(readFileSync(join(release!, file))),
      manifestSha256: createHash('sha256').update(manifest).digest('hex'),
    });
    for (const [index, ip] of samples.entries()) {
      const source = records[index];
      expect(source?.country.iso_code).toBeTruthy();
      let canonical: string | undefined;
      for (const language of DBIP_LANGUAGES) {
        const result = await lookup(ip, language);
        expect(result).not.toBeNull();
        expect(result!.country).toBe(source.country.iso_code);
        expect(result!.display.country).toBe(fallback(source.country.names, language) ?? source.country.iso_code);
        if (result!.city) expect(result!.display.city).toBe(fallback(source.city?.names, language));
        const current = JSON.stringify([result!.country, result!.region, result!.city]);
        canonical ??= current;
        expect(current).toBe(canonical);
      }
    }
  } finally { vi.unstubAllGlobals(); }
}, 60_000);
