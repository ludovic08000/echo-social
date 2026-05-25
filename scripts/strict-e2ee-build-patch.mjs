import fs from 'node:fs';

const file = 'src/lib/messaging/multiDeviceFanout.ts';
let src = fs.readFileSync(file, 'utf8');

const targetA = `if (!encrypted) encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, input.recipientUserId, input.recipientDeviceId);`;
const replacementA = `if (!encrypted) {
    encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, input.recipientUserId, input.recipientDeviceId);
    if (!encrypted && isKnownInvalidDeviceId(input.recipientDeviceId)) return null;
  }`;

const targetB = `if (!encrypted) encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, dev.user_id, dev.device_id);`;
const replacementB = `if (!encrypted) {
      encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, dev.user_id, dev.device_id);
      if (!encrypted && isKnownInvalidDeviceId(dev.device_id)) continue;
    }`;

let changed = false;
if (src.includes(targetA)) {
  src = src.replace(targetA, replacementA);
  changed = true;
}
if (src.includes(targetB)) {
  src = src.replace(targetB, replacementB);
  changed = true;
}

if (!src.includes('if (!encrypted && isKnownInvalidDeviceId(input.recipientDeviceId)) return null;')) {
  throw new Error('strict E2EE patch missing input-recipient guard');
}
if (!src.includes('if (!encrypted && isKnownInvalidDeviceId(dev.device_id)) continue;')) {
  throw new Error('strict E2EE patch missing device loop guard');
}

if (changed) fs.writeFileSync(file, src);
console.log('[strict-e2ee-build-patch] OK: invalid SPK devices never fallback to deviceWrap');
