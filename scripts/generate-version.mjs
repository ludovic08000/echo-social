import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ids = ['84aaa52143235807214bf3aa161dd03a','6508eb47a200893f49720fe84b9290b3','9da8c742a4fe81d1d9ce6c0ffb4e055b','75e575fcbfaa8066bcbc9105fc5f4ac8','c6601674b0f700f28c9f2956774eca97','52adb13ff236ae5c833c9d9049c0df71','b166de502d729356dcbd6c0b5b1a39b0','49cfdeab59355de3051925b4f09fba75','92585130870cedf210af1019379dbc61','450c0cd9af35813c8a99ec5bc0f39ab8'];

function addIds(src, setName) {
  for (const id of ids) {
    if (src.includes(`'${id}'`)) continue;
    const n = `${setName} = new Set<string>([`;
    if (src.includes(n)) src = src.replace(n, `${n}\n  '${id}',`);
  }
  return src;
}

function fanout() {
  const p = resolve(__dirname, '..', 'src/lib/messaging/multiDeviceFanout.ts');
  let s = addIds(readFileSync(p, 'utf8'), 'KNOWN_INVALID_DEVICE_IDS');
  const a = `if (!encrypted) encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, input.recipientUserId, input.recipientDeviceId);`;
  const ar = `if (!encrypted) {\n    encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, input.recipientUserId, input.recipientDeviceId);\n    if (!encrypted && isKnownInvalidDeviceId(input.recipientDeviceId)) return null;\n  }`;
  const b = `if (!encrypted) encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, dev.user_id, dev.device_id);`;
  const br = `if (!encrypted) {\n      encrypted = await x3dhWrapForDevice(input.plaintext, input.senderUserId, dev.user_id, dev.device_id);\n      if (!encrypted && isKnownInvalidDeviceId(dev.device_id)) continue;\n    }`;
  if (s.includes(a)) s = s.replace(a, ar);
  if (s.includes(b)) s = s.replace(b, br);
  if (!s.includes('isKnownInvalidDeviceId(input.recipientDeviceId)) return null')) throw new Error('fanout guard missing');
  if (!s.includes('isKnownInvalidDeviceId(dev.device_id)) continue')) throw new Error('fanout loop guard missing');
  writeFileSync(p, s);
}

function currentDevice() {
  const p = resolve(__dirname, '..', 'src/lib/messaging/currentDevice.ts');
  let s = readFileSync(p, 'utf8');
  const block = `\nconst BLOCKED_RECOVERY_DEVICE_IDS = new Set<string>([\n${ids.map(id => `  '${id}',`).join('\n')}\n]);\nfunction isBlockedRecoveryDeviceId(id: string | null | undefined): boolean { return !!id && BLOCKED_RECOVERY_DEVICE_IDS.has(id); }\n`;
  if (!s.includes('BLOCKED_RECOVERY_DEVICE_IDS')) s = s.replace(`let cachedFingerprints: { strict: string; loose: string; ultraLoose: string } | null = null;`, `let cachedFingerprints: { strict: string; loose: string; ultraLoose: string } | null = null;${block}`);
  s = s.replace(`if (localId) {\n        return persistEverywhere(localId);\n      }`, `if (localId) {\n        if (isBlockedRecoveryDeviceId(localId)) return persistEverywhere(generateId());\n        return persistEverywhere(localId);\n      }`);
  s = s.replace(`if (!error && typeof serverId === 'string' && serverId.length >= 16) {\n            console.log('[device-id] Recovered from server fingerprint binding', {\n              recovered: serverId.slice(0, 8),\n              platform,\n            });\n            return persistEverywhere(serverId);\n          }`, `if (!error && typeof serverId === 'string' && serverId.length >= 16) {\n            if (isBlockedRecoveryDeviceId(serverId)) return persistEverywhere(generateId());\n            console.log('[device-id] Recovered from server fingerprint binding', { recovered: serverId.slice(0, 8), platform });\n            return persistEverywhere(serverId);\n          }`);
  if (!s.includes('isBlockedRecoveryDeviceId(serverId)')) throw new Error('device recovery guard missing');
  writeFileSync(p, s);
}

function registrationContinuity() {
  const p = resolve(__dirname, '..', 'src/hooks/useDeviceRegistration.ts');
  let s = readFileSync(p, 'utf8');
  if (s.includes('signing-key-mismatch')) return writeFileSync(p, s);
  const anchor = `        if (!keys?.privateKey || !keys?.signingPrivateKey) {\n          console.warn('[useDeviceRegistration] identity private keys missing — abort device publish');\n          ranRef.current = false;\n          return;\n        }`;
  const guard = `${anchor}\n\n        try {\n          const { data: activeIdentity } = await supabase.from('user_public_keys').select('identity_key, signing_key').eq('user_id', user.id).eq('is_active', true).maybeSingle();\n          if (activeIdentity?.signing_key && activeIdentity.signing_key !== bundle.signingKey) {\n            window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', { detail: { source: 'device-registration', reason: 'signing-key-mismatch' } }));\n            ranRef.current = false;\n            return;\n          }\n          if (activeIdentity?.identity_key && activeIdentity.identity_key !== bundle.identityKey) {\n            window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', { detail: { source: 'device-registration', reason: 'identity-key-mismatch' } }));\n            ranRef.current = false;\n            return;\n          }\n        } catch {\n          ranRef.current = false;\n          return;\n        }`;
  if (!s.includes(anchor)) throw new Error('registration continuity anchor missing');
  s = s.replace(anchor, guard);
  if (!s.includes('signing-key-mismatch')) throw new Error('registration continuity guard missing');
  writeFileSync(p, s);
}

function mainStartup() {
  const p = resolve(__dirname, '..', 'src/main.tsx');
  let s = readFileSync(p, 'utf8');
  if (!s.includes('runE2EECleanStartup')) {
    s = s.replace(`import { installGlobalCrashHandlers } from "@/lib/crashLogger";`, `import { installGlobalCrashHandlers } from "@/lib/crashLogger";\nimport { runE2EECleanStartup } from "@/lib/e2eeCleanStartup";`);
    s = s.replace(`async function bootstrap() {\n  // Render the app ASAP`, `async function bootstrap() {\n  await runE2EECleanStartup().catch(() => {});\n\n  // Render the app ASAP`);
  }
  if (!s.includes('await runE2EECleanStartup()')) throw new Error('clean startup hook missing');
  writeFileSync(p, s);
}

fanout();
currentDevice();
registrationContinuity();
mainStartup();

const out = resolve(__dirname, '..', 'public/version.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ version: Date.now().toString(), builtAt: new Date().toISOString() }, null, 2));
console.log('[version] wrote', out);
