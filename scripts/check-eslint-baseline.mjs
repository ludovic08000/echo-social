import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const reportPath = process.argv[2] ?? 'eslint-report.json';
const BASELINE_GZIP_BASE64 = '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';

function readReport(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`[eslint-baseline] Cannot read ${filePath}:`, error);
    process.exit(2);
  }
}

function readBaseline() {
  try {
    const compressed = Buffer.from(BASELINE_GZIP_BASE64, 'base64');
    return JSON.parse(gunzipSync(compressed).toString('utf8'));
  } catch (error) {
    console.error('[eslint-baseline] Embedded baseline is invalid:', error);
    process.exit(2);
  }
}

const report = readReport(reportPath);
const baseline = readBaseline();
const expected = baseline?.entries ?? {};

if (!Array.isArray(report) || typeof expected !== 'object' || Array.isArray(expected)) {
  console.error('[eslint-baseline] Invalid report or baseline format.');
  process.exit(2);
}

const repoRoot = process.cwd();
const actual = new Map();

for (const fileResult of report) {
  const absolutePath = String(fileResult.filePath ?? '');
  const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join('/');

  for (const message of fileResult.messages ?? []) {
    if (message.severity !== 2) continue;
    const ruleId = message.ruleId ?? '<fatal>';
    const key = `${relativePath}|${ruleId}`;
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
}

const regressions = [];
for (const [key, count] of actual) {
  const allowed = Number(expected[key] ?? 0);
  if (count > allowed) regressions.push({ key, count, allowed });
}

const currentTotal = [...actual.values()].reduce((sum, count) => sum + count, 0);
const baselineTotal = Object.values(expected).reduce((sum, count) => sum + Number(count), 0);

console.log(`[eslint-baseline] Current errors: ${currentTotal}; allowed historical errors: ${baselineTotal}.`);

if (regressions.length > 0) {
  console.error(`[eslint-baseline] ${regressions.length} new or increased lint violation(s):`);
  for (const regression of regressions.sort((a, b) => a.key.localeCompare(b.key))) {
    console.error(`  ${regression.key}: ${regression.count} (allowed ${regression.allowed})`);
  }
  process.exit(1);
}

const improvements = [];
for (const [key, allowedValue] of Object.entries(expected)) {
  const allowed = Number(allowedValue);
  const count = actual.get(key) ?? 0;
  if (count < allowed) improvements.push({ key, count, allowed });
}

if (improvements.length > 0) {
  console.log(`[eslint-baseline] Historical debt reduced in ${improvements.length} rule/file bucket(s).`);
}

console.log('[eslint-baseline] No new ESLint errors.');
