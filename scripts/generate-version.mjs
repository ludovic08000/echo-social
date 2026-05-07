// Génère public/version.json à chaque build avec un timestamp unique.
// Le fichier est servi sans cache (configuré côté hébergeur).
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, '..', 'public', 'version.json');

mkdirSync(dirname(out), { recursive: true });

const payload = {
  version: Date.now().toString(),
  builtAt: new Date().toISOString(),
};

writeFileSync(out, JSON.stringify(payload, null, 2));
console.log('[version] wrote', out, payload);
