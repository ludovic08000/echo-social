import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [platform, variant = 'social'] = process.argv.slice(2);
if (!['android', 'ios'].includes(platform) || !['social', 'messenger'].includes(variant)) {
  throw new Error('Usage: node scripts/build-mobile.mjs android|ios social|messenger');
}
const env = { ...process.env, FORSURE_APP_VARIANT: variant, VITE_APP_VARIANT: variant };
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (platform === 'ios') {
  if (process.platform !== 'darwin') throw new Error('Compilation iOS : macOS et Xcode requis. Aucun IPA ne peut être produit sur Windows.');
  run('bash', ['scripts/bootstrap-ios-native.sh']);
} else {
  env.ANDROID_HOME ||= env.ANDROID_SDK_ROOT;
  if (!env.ANDROID_HOME && process.platform === 'win32') {
    const sdk = resolve(process.env.LOCALAPPDATA, 'Android/Sdk');
    if (existsSync(sdk)) env.ANDROID_HOME = sdk;
  }
  run('npm', ['run', 'build']);
  run('npx', ['--no-install', 'cap', 'sync', 'android']);
  run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
    [':app:assembleDebug', `-PforsureVariant=${variant}`, '--no-daemon', '--max-workers=2', '--console=plain'], resolve(root, 'android'));
  const output = resolve(root, 'build/mobile');
  mkdirSync(output, { recursive: true });
  const apk = resolve(output, `forsure-${variant}-debug.apk`);
  copyFileSync(resolve(root, 'android/app/build/outputs/apk/debug/app-debug.apk'), apk);
  console.log(`APK de test (signature debug, pas Play Store) : ${apk}`);
}
