import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, '..', 'public/version.json');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ version: Date.now().toString(), builtAt: new Date().toISOString() }, null, 2),
);
console.log('[version] wrote', out);
