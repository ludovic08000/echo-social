import { supabase } from '@/integrations/supabase/client';

const db = supabase as any;
const DEVICE_ID_STORAGE_KEY = 'echo_e2ee_browser_device_id';

export type TrustStatus = 'pending' | 'trusted' | 'revoked' | 'blocked';
export type RiskLevel = 'unknown' | 'low' | 'medium' | 'high' | 'blocked';

export interface BrowserDeviceInfo {
  deviceId: string;
  deviceName: string;
  browserName: string;
  browserVersion: string;
  osName: string;
  osVersion: string;
  platform: string;
  timezone: string;
  language: string;
  userAgentHash: string;
  clientHintsHash: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  ipHash?: string | null;
}

export interface TrustedDeviceRow {
  id: string;
  user_id: string;
  device_id: string;
  trust_status: TrustStatus;
  risk_level: RiskLevel;
  risk_reasons: string[] | null;
  browser_name: string | null;
  browser_version: string | null;
  os_name: string | null;
  os_version: string | null;
  platform: string | null;
  timezone: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  user_agent_hash: string | null;
  client_hints_hash: string | null;
  e2ee_public_key: string | null;
  e2ee_identity_fingerprint: string | null;
  last_seen_at: string;
}

export interface DeviceTrustAssessment {
  known: boolean;
  trusted: boolean;
  requiresPin: boolean;
  riskLevel: RiskLevel;
  reasons: string[];
  current: BrowserDeviceInfo;
  previous?: TrustedDeviceRow | null;
}

export interface RegisterTrustedDeviceInput {
  userId: string;
  deviceInfo: BrowserDeviceInfo;
  e2eePublicKey?: string | null;
  e2eeIdentityFingerprint?: string | null;
  signature?: string | null;
  trustStatus?: TrustStatus;
}

function randomDeviceId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getOrCreateBrowserDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;

  const deviceId = randomDeviceId();
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
  return deviceId;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseBrowser(userAgent: string): { name: string; version: string } {
  const rules: Array<[string, RegExp]> = [
    ['Edge', /Edg\/([0-9.]+)/],
    ['Chrome', /Chrome\/([0-9.]+)/],
    ['Firefox', /Firefox\/([0-9.]+)/],
    ['Safari', /Version\/([0-9.]+).*Safari/],
  ];

  for (const [name, regex] of rules) {
    const match = userAgent.match(regex);
    if (match?.[1]) return { name, version: match[1] };
  }

  return { name: 'Unknown', version: 'Unknown' };
}

function parseOS(userAgent: string, platform: string): { name: string; version: string } {
  const checks: Array<[string, RegExp]> = [
    ['Windows', /Windows NT ([0-9.]+)/],
    ['Android', /Android ([0-9.]+)/],
    ['iOS', /(?:iPhone|iPad).*OS ([0-9_]+)/],
    ['macOS', /Mac OS X ([0-9_]+)/],
    ['Linux', /Linux/],
  ];

  for (const [name, regex] of checks) {
    const match = userAgent.match(regex);
    if (match) return { name, version: (match[1] || platform || 'Unknown').replaceAll('_', '.') };
  }

  return { name: platform || 'Unknown', version: 'Unknown' };
}

async function getClientHintsHash(): Promise<string | null> {
  const nav = navigator as Navigator & {
    userAgentData?: {
      getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
    };
  };

  if (!nav.userAgentData?.getHighEntropyValues) return null;

  try {
    const hints = await nav.userAgentData.getHighEntropyValues([
      'platform',
      'platformVersion',
      'architecture',
      'model',
      'uaFullVersion',
      'fullVersionList',
    ]);
    return sha256Hex(JSON.stringify(hints));
  } catch {
    return null;
  }
}

export async function getCurrentBrowserDeviceInfo(
  location?: Pick<BrowserDeviceInfo, 'country' | 'region' | 'city' | 'ipHash'>,
): Promise<BrowserDeviceInfo> {
  const deviceId = getOrCreateBrowserDeviceId();
  const userAgent = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const browser = parseBrowser(userAgent);
  const os = parseOS(userAgent, platform);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown';

  return {
    deviceId,
    deviceName: `${browser.name} on ${os.name}`,
    browserName: browser.name,
    browserVersion: browser.version,
    osName: os.name,
    osVersion: os.version,
    platform,
    timezone,
    language: navigator.language || 'Unknown',
    userAgentHash: await sha256Hex(userAgent),
    clientHintsHash: await getClientHintsHash(),
    country: location?.country ?? null,
    region: location?.region ?? null,
    city: location?.city ?? null,
    ipHash: location?.ipHash ?? null,
  };
}

export function assessDeviceRisk(
  previous: TrustedDeviceRow | null,
  current: BrowserDeviceInfo,
): { riskLevel: RiskLevel; requiresPin: boolean; reasons: string[] } {
  if (!previous) {
    return { riskLevel: 'high', requiresPin: true, reasons: ['unknown_device'] };
  }

  const reasons: string[] = [];
  let score = 0;

  if (previous.trust_status === 'revoked') {
    return { riskLevel: 'blocked', requiresPin: true, reasons: ['device_revoked'] };
  }

  if (previous.trust_status === 'blocked') {
    return { riskLevel: 'blocked', requiresPin: true, reasons: ['device_blocked'] };
  }

  if (previous.device_id !== current.deviceId) {
    score += 80;
    reasons.push('device_id_changed');
  }

  if (previous.os_name && previous.os_name !== current.osName) {
    score += 45;
    reasons.push('os_changed');
  }

  if (previous.browser_name && previous.browser_name !== current.browserName) {
    score += 30;
    reasons.push('browser_changed');
  }

  if (previous.timezone && previous.timezone !== current.timezone) {
    score += 20;
    reasons.push('timezone_changed');
  }

  if (previous.country && current.country && previous.country !== current.country) {
    score += 35;
    reasons.push('country_changed');
  }

  if (previous.city && current.city && previous.city !== current.city) {
    score += 10;
    reasons.push('city_changed');
  }

  if (previous.user_agent_hash && previous.user_agent_hash !== current.userAgentHash) {
    score += 10;
    reasons.push('user_agent_changed');
  }

  if (previous.client_hints_hash && current.clientHintsHash && previous.client_hints_hash !== current.clientHintsHash) {
    score += 15;
    reasons.push('client_hints_changed');
  }

  if (previous.trust_status !== 'trusted') {
    score += 70;
    reasons.push('device_not_trusted');
  }

  if (score >= 90) return { riskLevel: 'blocked', requiresPin: true, reasons };
  if (score >= 50) return { riskLevel: 'high', requiresPin: true, reasons };
  if (score >= 25) return { riskLevel: 'medium', requiresPin: true, reasons };
  return { riskLevel: 'low', requiresPin: false, reasons };
}

export async function fetchTrustedDevice(userId: string, deviceId: string): Promise<TrustedDeviceRow | null> {
  const { data, error } = await db
    .from('user_trusted_devices')
    .select('*')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error) throw error;
  return data as TrustedDeviceRow | null;
}

export async function registerOrUpdateTrustedDevice(input: RegisterTrustedDeviceInput): Promise<void> {
  const { userId, deviceInfo } = input;
  const safeTrustStatus: TrustStatus = input.trustStatus === 'trusted' ? 'pending' : input.trustStatus ?? 'pending';

  const payload = {
    user_id: userId,
    device_id: deviceInfo.deviceId,
    device_name: deviceInfo.deviceName,
    browser_name: deviceInfo.browserName,
    browser_version: deviceInfo.browserVersion,
    os_name: deviceInfo.osName,
    os_version: deviceInfo.osVersion,
    platform: deviceInfo.platform,
    user_agent_hash: deviceInfo.userAgentHash,
    client_hints_hash: deviceInfo.clientHintsHash,
    timezone: deviceInfo.timezone,
    country: deviceInfo.country,
    region: deviceInfo.region,
    city: deviceInfo.city,
    ip_hash: deviceInfo.ipHash,
    e2ee_public_key: input.e2eePublicKey ?? null,
    e2ee_identity_fingerprint: input.e2eeIdentityFingerprint ?? null,
    signature: input.signature ?? null,
    signed_at: input.signature ? new Date().toISOString() : null,
    trust_status: safeTrustStatus,
    last_seen_at: new Date().toISOString(),
  };

  const { error } = await db
    .from('user_trusted_devices')
    .upsert(payload, { onConflict: 'user_id,device_id' });

  if (error) throw error;
}

export async function assessCurrentBrowserDevice(
  userId: string,
  location?: Pick<BrowserDeviceInfo, 'country' | 'region' | 'city' | 'ipHash'>,
): Promise<DeviceTrustAssessment> {
  const current = await getCurrentBrowserDeviceInfo(location);
  const previous = await fetchTrustedDevice(userId, current.deviceId);
  const risk = assessDeviceRisk(previous, current);

  if (!previous) {
    await registerOrUpdateTrustedDevice({
      userId,
      deviceInfo: current,
      trustStatus: 'pending',
    });
  } else {
    const { error } = await db.rpc('touch_my_browser_device', {
      _device_id: current.deviceId,
      _risk_level: risk.riskLevel,
      _risk_reasons: risk.reasons,
    });

    if (error) {
      await db
        .from('user_trusted_devices')
        .update({
          risk_level: risk.riskLevel,
          risk_reasons: risk.reasons,
          last_seen_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('device_id', current.deviceId)
        .neq('trust_status', 'trusted')
        .catch?.(() => undefined);
    }
  }

  return {
    known: Boolean(previous),
    trusted: previous?.trust_status === 'trusted' && !risk.requiresPin,
    requiresPin: risk.requiresPin,
    riskLevel: risk.riskLevel,
    reasons: risk.reasons,
    current,
    previous,
  };
}

export async function trustCurrentDeviceAfterPin(input: {
  userId: string;
  e2eePublicKey?: string | null;
  e2eeIdentityFingerprint?: string | null;
  signature?: string | null;
  location?: Pick<BrowserDeviceInfo, 'country' | 'region' | 'city' | 'ipHash'>;
}): Promise<BrowserDeviceInfo> {
  const deviceInfo = await getCurrentBrowserDeviceInfo(input.location);
  const existing = await fetchTrustedDevice(input.userId, deviceInfo.deviceId);

  if (!existing) {
    await registerOrUpdateTrustedDevice({
      userId: input.userId,
      deviceInfo,
      e2eePublicKey: input.e2eePublicKey,
      e2eeIdentityFingerprint: input.e2eeIdentityFingerprint,
      signature: input.signature,
      trustStatus: 'pending',
    });
  }

  const { error } = await db.rpc('trust_my_browser_device', {
    _device_id: deviceInfo.deviceId,
    _e2ee_public_key: input.e2eePublicKey ?? null,
    _e2ee_identity_fingerprint: input.e2eeIdentityFingerprint ?? null,
    _signature: input.signature ?? null,
  });

  if (error) {
    const { error: updateError } = await db
      .from('user_trusted_devices')
      .update({
        trust_status: 'trusted',
        trusted_at: new Date().toISOString(),
        risk_level: 'low',
        risk_reasons: [],
        e2ee_public_key: input.e2eePublicKey ?? existing?.e2ee_public_key ?? null,
        e2ee_identity_fingerprint: input.e2eeIdentityFingerprint ?? existing?.e2ee_identity_fingerprint ?? null,
        signature: input.signature ?? null,
        signed_at: input.signature ? new Date().toISOString() : null,
        last_seen_at: new Date().toISOString(),
      })
      .eq('user_id', input.userId)
      .eq('device_id', deviceInfo.deviceId);

    if (updateError) throw updateError;
  }

  return deviceInfo;
}

export async function revokeCurrentBrowserDevice(userId: string): Promise<void> {
  const deviceId = getOrCreateBrowserDeviceId();

  const { error } = await db.rpc('revoke_my_trusted_device', {
    _device_id: deviceId,
  });

  if (error) {
    await db
      .from('user_trusted_devices')
      .update({
        trust_status: 'revoked',
        revoked_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('device_id', deviceId);
  }
}
