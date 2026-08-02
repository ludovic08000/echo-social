import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const write = (path, value) => writeFileSync(path, value, 'utf8');

const migrationPath = 'scripts/apply-signal-audit-fixes.mjs';
let migration = read(migrationPath);

const obsoleteGuard = /\nreplaceExact\(\n  'src\/lib\/crypto\/accountKeyBackup\.ts',\n  `async function hasLocalAccountIdentity\(userId: string\): Promise<boolean>`,\n  `export async function hasLocalAccountIdentity\(userId: string\): Promise<boolean>`,\n  0,\n\);\n/;
if (!obsoleteGuard.test(migration)) {
  throw new Error('Obsolete account-identity migration guard not found');
}
migration = migration.replace(obsoleteGuard, '\n');
migration = migration.replace(
  "expect(backup).toContain('device-signing::${userId}::${currentDeviceId}');",
  "expect(backup).toContain('device-signing::\\${userId}::\\${currentDeviceId}');",
);
write(migrationPath, migration);

await import('./apply-signal-audit-fixes.mjs');

const hookPath = 'src/hooks/useE2EE.ts';
let hook = read(hookPath);
const initializationSave = 'saveKnownFingerprint(peerUserId, peerKey.fingerprint);';
if ((hook.split(initializationSave).length - 1) !== 1) {
  throw new Error('Expected one initialization fingerprint save');
}
hook = hook.replace(
  initializationSave,
  'saveKnownFingerprint(user.id, peerUserId, peerKey.fingerprint);',
);
const acknowledgementBefore = `  const acknowledgeFingerprint = useCallback(async () => {
    if (!peerUserId || !state.peerFingerprint) return;
    saveKnownFingerprint(peerUserId, state.peerFingerprint);`;
const acknowledgementAfter = `  const acknowledgeFingerprint = useCallback(async () => {
    if (!user || !peerUserId || !state.peerFingerprint) return;
    saveKnownFingerprint(user.id, peerUserId, state.peerFingerprint);`;
if (!hook.includes(acknowledgementBefore)) {
  throw new Error('Fingerprint acknowledgement block not found');
}
hook = hook.replace(acknowledgementBefore, acknowledgementAfter);
hook = hook.replace(
  '  }, [peerUserId, state.peerFingerprint]);',
  '  }, [peerUserId, state.peerFingerprint, user]);',
);
write(hookPath, hook);

unlinkSync('.github/aegis-signal-audit-trigger');

write('.github/workflows/crypto-tests.yml', `name: Crypto Test Suite

on:
  push:
    branches: [main]
    paths:
      - 'src/lib/crypto/**'
      - 'src/lib/messaging/**'
      - 'src/test/**'
      - 'package.json'
      - 'package-lock.json'
      - 'vitest.config.ts'
      - '.github/workflows/crypto-tests.yml'
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  test:
    name: Run crypto test suite
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run crypto + messaging test suite
        id: tests
        run: |
          mkdir -p test-results
          npm exec vitest run -- \\
            src/lib/crypto/__tests__ \\
            src/lib/messaging/__tests__ \\
            --reporter=default \\
            --reporter=junit \\
            --outputFile=test-results/junit.xml 2>&1 | tee test-results/output.log

      - name: Upload test artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: crypto-test-results-\${{ github.run_id }}
          path: |
            test-results/
            coverage/
          retention-days: 14
          if-no-files-found: warn
`);

unlinkSync('scripts/run-signal-audit-ci.mjs');
console.log('Guarded Signal audit workspace prepared.');
