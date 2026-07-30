import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/components/KeyBackupPanel.tsx';
let source = readFileSync(path, 'utf8');

const importAnchor = "import { BackupPinSection } from '@/components/BackupPinSection';";
const importLine = "import { AegisRecoveryKeySection } from '@/components/AegisRecoveryKeySection';";
if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) throw new Error('KeyBackupPanel import anchor missing');
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

const panelAnchor = `            {/* L5 — WhatsApp-style 6-digit PIN backup */}\n            <BackupPinSection />`;
const panelReplacement = `            <AegisRecoveryKeySection />\n\n            {/* L5 — WhatsApp-style 6-digit PIN backup */}\n            <BackupPinSection />`;
if (!source.includes('<AegisRecoveryKeySection />')) {
  if (!source.includes(panelAnchor)) throw new Error('KeyBackupPanel recovery anchor missing');
  source = source.replace(panelAnchor, panelReplacement);
}

writeFileSync(path, source);
