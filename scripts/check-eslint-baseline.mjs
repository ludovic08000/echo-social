import fs from 'node:fs';
import path from 'node:path';

const reportPath = process.argv[2] ?? 'eslint-report.json';
const baselinePath = process.argv[3] ?? 'scripts/eslint-baseline.json';

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`[eslint-baseline] Cannot read ${filePath}:`, error);
    process.exit(2);
  }
}

const report = readJson(reportPath);
const baseline = readJson(baselinePath);
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
