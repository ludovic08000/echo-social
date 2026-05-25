// Génère public/version.json à chaque build avec un timestamp unique.
// Applique aussi les patchs E2EE stricts avant le build Vite.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const INVALID_E2EE_DEVICE_IDS = [
  '84aaa52143235807214bf3aa161dd03a',
  '6508eb47a200893f49720fe84b9290b3',
  '9da8c742a4fe81d1d9ce6c0ffb4e055b',
  '75e575fcbfaa8066bcbc9105fc5f4ac8',
  'c6601674b0f700f28c9f2956774eca97',
  '52adb13ff236ae5c833c9d9049c0df71',
  'b166de502d729356dcbd6c0b5b1a39b0',
  '49cfdeab59355de3051925b4f09fba75',
  '92585130870cedf210af1019379dbc61',
  '450c0cd9af35813c8a99ec5bc0f39ab8',
];

function ensureInvalidIdsInSet(src, setName) {
  for (const id of INVALID_E2EE_DEVICE_IDS) {
    if (src.includes(`'${id}'`)) continue;
    const needle = `${setName} = new Set<string>([`;
    if (!src.includes(needle)) continue;
    src = src.replace(needle, `${needle}\n  '${id}',`);
  }
  return src;
}

function applyStrictFanoutPatch() {
  const target = resolve(__dirname, '..', 'src', 'lib', 'messaging', 'multiDeviceFanout.ts');
  let src = readFileSync(target, 'utf8');

  src = ensureInvalidIdsInSet(src, 'KNOWN_INVALID_DEVICE_IDS');

  const beforeA = `if (!encrypted) encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, input.recipientUserId, input.recipientDeviceId);`;
  const afterA = `if (!encrypted) {
    encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, input.recipientUserId, input.recipientDeviceId);
    if (!encrypted && isKnownInvalidDeviceId(input.recipientDeviceId)) return null;
  }`;

  const beforeB = `if (!encrypted) encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, dev.user_id, dev.device_id);`;
  const afterB = `if (!encrypted) {
      encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, dev.user_id, dev.device_id);
      if (!encrypted && isKnownInvalidDeviceId(dev.device_id)) continue;
    }`;

  if (src.includes(beforeA)) src = src.replace(beforeA, afterA);
  if (src.includes(beforeB)) src = src.replace(beforeB, afterB);

  for (const id of INVALID_E2EE_DEVICE_IDS) {
    if (!src.includes(`'${id}'`)) throw new Error(`strict E2EE fanout patch failed: missing invalid device ${id}`);
  }
  if (!src.includes('if (!encrypted && isKnownInvalidDeviceId(input.recipientDeviceId)) return null;')) {
    throw new Error('strict E2EE fanout patch failed: missing input-recipient guard');
  }
  if (!src.includes('if (!encrypted && isKnownInvalidDeviceId(dev.device_id)) continue;')) {
    throw new Error('strict E2EE fanout patch failed: missing device-loop guard');
  }

  writeFileSync(target, src);
  console.log('[strict-e2ee] invalid SPK devices cannot fallback to deviceWrap');
}

function applyRevokedDeviceRecoveryPatch() {
  const target = resolve(__dirname, '..', 'src', 'lib', 'messaging', 'currentDevice.ts');
  let src = readFileSync(target, 'utf8');

  const invalidFn = `
const BLOCKED_RECOVERY_DEVICE_IDS = new Set<string>([
${INVALID_E2EE_DEVICE_IDS.map((id) => `  '${id}',`).join('\n')}
]);

function isBlockedRecoveryDeviceId(id: string | null | undefined): boolean {
  return !!id && BLOCKED_RECOVERY_DEVICE_IDS.has(id);
}
`;

  if (!src.includes('BLOCKED_RECOVERY_DEVICE_IDS')) {
    src = src.replace(`let cachedFingerprints: { strict: string; loose: string; ultraLoose: string } | null = null;`, `let cachedFingerprints: { strict: string; loose: string; ultraLoose: string } | null = null;${invalidFn}`);
  } else {
    src = ensureInvalidIdsInSet(src, 'BLOCKED_RECOVERY_DEVICE_IDS');
  }

  src = src.replace(
    `if (localId) {\n        return persistEverywhere(localId);\n      }`,
    `if (localId) {\n        if (isBlockedRecoveryDeviceId(localId)) return persistEverywhere(generateId());\n        return persistEverywhere(localId);\n      }`,
  );

  src = src.replace(
    `if (!error && typeof serverId === 'string' && serverId.length >= 16) {\n            console.log('[device-id] Recovered from server fingerprint binding', {\n              recovered: serverId.slice(0, 8),\n              platform,\n            });\n            return persistEverywhere(serverId);\n          }`,
    `if (!error && typeof serverId === 'string' && serverId.length >= 16) {\n            if (isBlockedRecoveryDeviceId(serverId)) {\n              return persistEverywhere(generateId());\n            }\n            console.log('[device-id] Recovered from server fingerprint binding', {\n              recovered: serverId.slice(0, 8),\n              platform,\n            });\n            return persistEverywhere(serverId);\n          }`,
  );

  for (const id of INVALID_E2EE_DEVICE_IDS) {
    if (!src.includes(`'${id}'`)) throw new Error(`revoked device recovery patch failed: missing blocked device ${id}`);
  }
  if (!src.includes('isBlockedRecoveryDeviceId(serverId)')) {
    throw new Error('revoked device recovery patch failed: missing server recovery guard');
  }

  writeFileSync(target, src);
  console.log('[strict-e2ee] revoked/invalid device ids cannot be recovered from storage/fingerprint');
}

applyStrictFanoutPatch();
applyRevokedDeviceRecoveryPatch();

const out = resolve(__dirname, '..', 'public', 'version.json');
mkdirSync(dirname(out), { recursive: true });

const payload = {
  version: Date.now().toString(),
  builtAt: new Date().toISOString(),
};

writeFileSync(out, JSON.stringify(payload, null, 2));
console.log('[version] wrote', out, payload);
