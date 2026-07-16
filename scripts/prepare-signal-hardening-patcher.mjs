import { readFileSync, writeFileSync } from 'node:fs';

const path = 'scripts/apply-signal-hardening.mjs';
let source = readFileSync(path, 'utf8');
const needle = `  return source.slice(bodyStart, end);\n}`;
const replacement = `  return source.slice(bodyStart, end)\n    .replace(/\\$\\{'(\\$\\{[^']+\\})'\\}/g, '$1')\n    .replace(/\\\\\`/g, '\`');\n}`;

if (!source.includes(needle) && !source.includes(replacement)) {
  throw new Error('extractTemplate normalization anchor missing');
}

source = source.replace(needle, replacement);
writeFileSync(path, source, 'utf8');
