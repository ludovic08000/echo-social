// Génère public/version.json à chaque build avec un timestamp unique.
// Applique aussi le patch E2EE strict avant le build Vite.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function applyStrictE2EEPatch() {
  const target = resolve(__dirname, '..', 'src', 'lib', 'messaging', 'multiDeviceFanout.ts');
  let src = readFileSync(target, 'utf8');

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

  if (!src.includes('if (!encrypted && isKnownInvalidDeviceId(input.recipientDeviceId)) return null;')) {
    throw new Error('strict E2EE patch failed: missing input-recipient guard');
  }
  if (!src.includes('if (!encrypted && isKnownInvalidDeviceId(dev.device_id)) continue;')) {
    throw new Error('strict E2EE patch failed: missing device-loop guard');
  }

  writeFileSync(target, src);
  console.log('[strict-e2ee] invalid SPK devices cannot fallback to deviceWrap');
}

applyStrictE2EEPatch();

const out = resolve(__dirname, '..', 'public', 'version.json');
mkdirSync(dirname(out), { recursive: true });

const payload = {
  version: Date.now().toString(),
  builtAt: new Date().toISOString(),
};

writeFileSync(out, JSON.stringify(payload, null, 2));
console.log('[version] wrote', out, payload);
