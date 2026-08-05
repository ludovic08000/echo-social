from pathlib import Path
import re
import textwrap


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"missing anchor: {label}")
    return text.replace(old, new, 1)


resync_path = Path("src/lib/crypto/resyncE2EE.ts")
text = resync_path.read_text(encoding="utf-8")

text = replace_once(
    text,
    "  hydrateDeviceId,\n} from '@/lib/messaging/currentDevice';",
    "  hydrateDeviceId,\n  setCurrentDeviceId,\n} from '@/lib/messaging/currentDevice';",
    "setCurrentDeviceId import",
)

enrollment_import = """import {
  beginServerAssignedDeviceEnrollment,
  completeServerAssignedDeviceEnrollment,
  hasRegisteredDevice,
  type DeviceEnrollmentChallenge,
} from '@/lib/crypto/serverDeviceEnrollment';
"""
identity_import = "import { prepareDeviceAuthorization } from '@/lib/crypto/deviceIdentity';\n"
if enrollment_import not in text:
    text = replace_once(
        text,
        identity_import,
        identity_import + enrollment_import,
        "server enrollment import",
    )

old_header = """async function republishDeviceIdentity(
  userId: string,
  deviceId: string,
  diag?: DiagRecorder,
): Promise<{ identity: boolean; spk: boolean; opks: boolean }> {
  const result = { identity: false, spk: false, opks: false };
"""
new_header = """async function republishDeviceIdentity(
  userId: string,
  deviceId: string,
  diag?: DiagRecorder,
): Promise<{
  identity: boolean;
  spk: boolean;
  opks: boolean;
  deviceId: string;
  serverAssigned: boolean;
}> {
  const result = {
    identity: false,
    spk: false,
    opks: false,
    deviceId,
    serverAssigned: false,
  };
"""
text = replace_once(text, old_header, new_header, "republish result shape")

bundle_anchor = """  if (!bundle?.identityKey || !bundle?.signingKey || !keys?.signingPrivateKey) {
    throw new Error('identity bundle incomplete (identityKey/signingKey missing)');
  }

"""
route_resolution = """  if (!bundle?.identityKey || !bundle?.signingKey || !keys?.signingPrivateKey) {
    throw new Error('identity bundle incomplete (identityKey/signingKey missing)');
  }

  let enrollmentChallenge: DeviceEnrollmentChallenge | null = null;
  const routeExists = await hasRegisteredDevice(userId, deviceId);
  if (!routeExists) {
    const enrollmentPlatform = normalizePlatform(getCurrentPlatform());
    const enrollmentDeviceName = (getCurrentDeviceLabel() || 'Unknown device').slice(0, 120);
    const enrollmentUserAgent = typeof navigator !== 'undefined'
      ? (navigator.userAgent || '').slice(0, 500)
      : null;
    let enrollmentFingerprint: string | null = null;
    try {
      const { getDeviceFingerprint } = await import('@/lib/messaging/currentDevice');
      enrollmentFingerprint = await getDeviceFingerprint();
    } catch {
      // Advisory metadata only. The challenge and device keys are authoritative.
    }

    diag?.push('identity', 'info', 'stage server_device_id.begin', {
      platform: enrollmentPlatform,
    });
    enrollmentChallenge = await beginServerAssignedDeviceEnrollment({
      deviceName: enrollmentDeviceName,
      deviceFingerprint: enrollmentFingerprint,
      platform: enrollmentPlatform,
      userAgent: enrollmentUserAgent,
    });
    deviceId = enrollmentChallenge.deviceId;
    result.deviceId = deviceId;
    result.serverAssigned = true;
    diag?.push('identity', 'success', 'server DeviceID allocated', {
      deviceIdLength: deviceId.length,
    });
  }

"""
text = replace_once(text, bundle_anchor, route_resolution, "server DeviceID resolution")

rpc_start = "  try {\n    const { data: registerData, error: registerErr } = await supabase.rpc('register_user_device_safe', {"
catch_marker = "\n  } catch (e) {\n    console.error('[E2EE][IDENTITY][FAIL]', {"
if "completeServerAssignedDeviceEnrollment(\n        enrollmentChallenge" not in text:
    start = text.find(rpc_start)
    if start < 0:
        raise RuntimeError("missing anchor: existing registration RPC")
    catch_start = text.find(catch_marker, start)
    if catch_start < 0:
        raise RuntimeError("missing anchor: registration catch")

    body_start = start + len("  try {\n")
    existing_body = text[body_start:catch_start]
    nested_body = textwrap.indent(existing_body, "  ")
    replacement = """  try {
    if (enrollmentChallenge) {
      const completedDeviceId = await completeServerAssignedDeviceEnrollment(
        enrollmentChallenge,
        authorization,
      );
      if (completedDeviceId !== deviceId) {
        throw new Error('DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
      }
      // Commit the routing identity only after the server transaction succeeds.
      setCurrentDeviceId(completedDeviceId);
      result.deviceId = completedDeviceId;
      result.identity = true;
      diag?.push('identity', 'success', 'server device enrollment completed', {
        deviceIdLength: completedDeviceId.length,
      });
    } else {
""" + nested_body + "\n    }"
    text = text[:start] + replacement + text[catch_start:]

text = text.replace(
    "      step: 'user_devices_register_safe',",
    "      step: enrollmentChallenge ? 'server_device_enrollment' : 'user_devices_register_safe',",
    1,
)

old_report = """    const pub = await republishDeviceIdentity(userId, deviceId, diag);
    report.steps.identity = pub.identity ? 'ok' : 'error';
"""
new_report = """    const pub = await republishDeviceIdentity(userId, deviceId, diag);
    deviceId = pub.deviceId;
    report.deviceId = deviceId;
    report.steps.identity = pub.identity ? 'ok' : 'error';
"""
text = replace_once(text, old_report, new_report, "resync authoritative DeviceID")

resync_path.write_text(text, encoding="utf-8")

pin_path = Path("src/components/PinValidatedMessaging.tsx")
pin_text = pin_path.read_text(encoding="utf-8")
if "E2EE_DEVICE_ID_SERVER_ASSIGNED" not in pin_text:
    pattern = re.compile(r"(?P<indent>^[ \t]*)await markCurrentRouteReady\(deviceId\);", re.M)

    def insert_server_id(match: re.Match[str]) -> str:
        indent = match.group("indent")
        return (
            f"{indent}if (report.deviceId && report.deviceId !== deviceId) {{\n"
            f"{indent}  deviceId = report.deviceId;\n"
            f"{indent}  recordEnrollment(\n"
            f"{indent}    'E2EE_DEVICE_ID_SERVER_ASSIGNED',\n"
            f"{indent}    'ready',\n"
            f"{indent}    'server_device_id',\n"
            f"{indent}  );\n"
            f"{indent}}}\n\n"
            f"{indent}await markCurrentRouteReady(deviceId);"
        )

    pin_text, count = pattern.subn(insert_server_id, pin_text, count=1)
    if count != 1:
        raise RuntimeError(f"markCurrentRouteReady patch count={count}")
pin_path.write_text(pin_text, encoding="utf-8")

current_path = Path("src/lib/messaging/currentDevice.ts")
current_text = current_path.read_text(encoding="utf-8")
current_text = current_text.replace(
    "console.log('[device-id] forcing device id from backup'",
    "console.log('[device-id] committing authoritative device id'",
    1,
)
current_path.write_text(current_text, encoding="utf-8")

print("stage 2 server-assigned enrollment client patch applied")
