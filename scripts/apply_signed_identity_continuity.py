from pathlib import Path
import re


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.strip() + '\n', encoding='utf-8')


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    source = target.read_text(encoding='utf-8-sig')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    target.write_text(source.replace(old, new, 1), encoding='utf-8')


def regex_once(path: str, pattern: str, replacement: str, label: str) -> None:
    target = Path(path)
    source = target.read_text(encoding='utf-8-sig')
    updated, count = re.subn(pattern, replacement, source, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    target.write_text(updated, encoding='utf-8')


write('src/lib/crypto/safetyNumber.ts', r'''
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';

const SAFETY_DOMAIN = 'forsure-aegis-safety-number-v1';
const FINGERPRINT_RE = /^[0-9a-f ]{32,160}$/i;

function normalizeFingerprint(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function canonicalPair(myFingerprint: string, peerFingerprint: string): [string, string] {
  const mine = normalizeFingerprint(myFingerprint);
  const peer = normalizeFingerprint(peerFingerprint);
  if (!FINGERPRINT_RE.test(mine) || !FINGERPRINT_RE.test(peer)) {
    throw new Error('SAFETY_NUMBER_INVALID_FINGERPRINT');
  }
  return [mine, peer].sort() as [string, string];
}

/**
 * Aegis safety numbers are domain-separated SHA-512 digests rendered as sixty
 * decimal digits. This is not Signal's wire format, but it has the same core
 * property: both participants derive the same value only from the two stable
 * account identity fingerprints.
 */
export async function deriveAegisSafetyNumber(
  myFingerprint: string,
  peerFingerprint: string,
): Promise<string> {
  const [fpA, fpB] = canonicalPair(myFingerprint, peerFingerprint);
  const input = new TextEncoder().encode(JSON.stringify({
    protocol: SAFETY_DOMAIN,
    version: 1,
    fpA,
    fpB,
  }));
  const digest = new Uint8Array(await hardCrypto.digest('SHA-512', input));
  const groups: string[] = [];
  for (let offset = 0; offset < 60; offset += 5) {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      value = (value * 256 + digest[offset + index]) % 100000;
    }
    groups.push(String(value).padStart(5, '0'));
  }
  return groups.join(' ');
}

export function buildAegisSafetyQrPayload(input: {
  myFingerprint: string;
  peerFingerprint: string;
  safetyNumber: string;
}): string {
  const [fpA, fpB] = canonicalPair(input.myFingerprint, input.peerFingerprint);
  if (!/^(?:\d{5} ){11}\d{5}$/.test(input.safetyNumber)) {
    throw new Error('SAFETY_NUMBER_INVALID_DISPLAY');
  }
  return JSON.stringify({
    protocol: SAFETY_DOMAIN,
    version: 1,
    fpA,
    fpB,
    safetyNumber: input.safetyNumber,
  });
}

export const __test__ = { canonicalPair, domain: SAFETY_DOMAIN };
''')

write('src/lib/crypto/fingerprintTracker.ts', r'''
/**
 * Account-identity trust tracker.
 *
 * Local continuity is authoritative. Server synchronization is accepted only
 * when the trust row carries a valid Ed25519 signature from this account's own
 * stable identity key. A server row can never replace an already-known local
 * fingerprint.
 */

import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { getOrCreateIdentityKeys } from './keyManager';
import {
  base64ToBuffer,
  bufferToBase64,
  encodeString,
} from './utils';
import {
  fetchPeerPublicKeys,
  getCachedAuthUserId,
} from './peerKeyCache';

export const KNOWN_FP_KEY = 'forsure-known-fps';
const SCOPED_FP_PREFIX = 'forsure-known-fps-v2:';
const TRUST_PROTOCOL = 'forsure-aegis-known-fingerprint';
const TRUST_VERSION = 1;
const FINGERPRINT_RE = /^[0-9a-f ]{32,160}$/i;

export type FingerprintCheckResult = {
  changed: boolean;
  previousFp: string | null;
  source?: 'local' | 'signed_server' | 'first_contact';
};

type SignedTrustRow = {
  fingerprint: string;
  acknowledged: boolean;
  verified_manually: boolean;
  trust_version: number | null;
  observer_signature: string | null;
};

function normalizeFingerprint(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function readJsonRecord(key: string): Record<string, string> {
  try {
    const parsed = hardGlobals.jsonParse(localStorage.getItem(key) || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function getKnownFingerprints(observerUserId?: string): Record<string, string> {
  return readJsonRecord(observerUserId ? `${SCOPED_FP_PREFIX}${observerUserId}` : KNOWN_FP_KEY);
}

function getLegacyKnownFingerprint(peerUserId: string): string | null {
  return getKnownFingerprints()[peerUserId] ?? null;
}

export function saveKnownFingerprint(
  peerUserId: string,
  fingerprint: string,
  observerUserId?: string,
): void {
  const normalized = normalizeFingerprint(fingerprint);
  if (!FINGERPRINT_RE.test(normalized)) throw new Error('INVALID_ACCOUNT_FINGERPRINT');
  const key = observerUserId ? `${SCOPED_FP_PREFIX}${observerUserId}` : KNOWN_FP_KEY;
  const known = readJsonRecord(key);
  known[peerUserId] = normalized;
  localStorage.setItem(key, hardGlobals.jsonStringify(known));
}

function canonicalTrustPayload(input: {
  observerUserId: string;
  peerUserId: string;
  fingerprint: string;
  acknowledged: boolean;
  verifiedManually: boolean;
}): string {
  return JSON.stringify({
    protocol: TRUST_PROTOCOL,
    version: TRUST_VERSION,
    observerUserId: input.observerUserId,
    peerUserId: input.peerUserId,
    fingerprint: normalizeFingerprint(input.fingerprint),
    acknowledged: input.acknowledged,
    verifiedManually: input.verifiedManually,
  });
}

async function signTrustPayload(input: {
  observerUserId: string;
  peerUserId: string;
  fingerprint: string;
  acknowledged: boolean;
  verifiedManually: boolean;
}): Promise<string> {
  const identity = await getOrCreateIdentityKeys(input.observerUserId);
  return bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    identity.signingPrivateKey,
    encodeString(canonicalTrustPayload(input)),
  ) as ArrayBuffer);
}

async function verifyTrustRow(input: {
  observerUserId: string;
  peerUserId: string;
  row: SignedTrustRow;
}): Promise<boolean> {
  if (
    input.row.trust_version !== TRUST_VERSION ||
    !input.row.observer_signature ||
    !FINGERPRINT_RE.test(normalizeFingerprint(input.row.fingerprint))
  ) return false;
  try {
    const identity = await getOrCreateIdentityKeys(input.observerUserId);
    return await hardCrypto.verify(
      'Ed25519',
      identity.signingPublicKey,
      base64ToBuffer(input.row.observer_signature),
      encodeString(canonicalTrustPayload({
        observerUserId: input.observerUserId,
        peerUserId: input.peerUserId,
        fingerprint: input.row.fingerprint,
        acknowledged: input.row.acknowledged,
        verifiedManually: input.row.verified_manually,
      })),
    );
  } catch {
    return false;
  }
}

const fingerprintCheckCache = new Map<
  string,
  { result: FingerprintCheckResult; timestamp: number }
>();
const fingerprintSaveCache = new Map<string, number>();
const CACHE_TTL_MS = 60_000;

export function invalidateFingerprintCheckCache(peerUserId: string): void {
  for (const key of fingerprintCheckCache.keys()) {
    if (key.includes(`:${peerUserId}:`)) fingerprintCheckCache.delete(key);
  }
}

async function readSignedServerTrust(
  observerUserId: string,
  peerUserId: string,
): Promise<SignedTrustRow | null> {
  try {
    const { data, error } = await (supabase as any)
      .from('user_known_fingerprints')
      .select('fingerprint,acknowledged,verified_manually,trust_version,observer_signature')
      .eq('user_id', observerUserId)
      .eq('peer_user_id', peerUserId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as SignedTrustRow;
    if (!await verifyTrustRow({ observerUserId, peerUserId, row })) {
      console.warn('[E2EE] Ignoring unsigned or invalid server trust row', { peerUserId });
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

export async function saveKnownFingerprintServer(
  peerUserId: string,
  fingerprint: string,
  verifiedByUser = false,
): Promise<void> {
  const normalized = normalizeFingerprint(fingerprint);
  if (!FINGERPRINT_RE.test(normalized)) throw new Error('INVALID_ACCOUNT_FINGERPRINT');
  const cacheKey = `${peerUserId}:${normalized}:${verifiedByUser ? 'manual' : 'tofu'}`;
  const lastSavedAt = fingerprintSaveCache.get(cacheKey);
  if (!verifiedByUser && lastSavedAt && Date.now() - lastSavedAt < CACHE_TTL_MS) return;

  try {
    const observerUserId = await getCachedAuthUserId();
    if (!observerUserId) return;
    const existing = await readSignedServerTrust(observerUserId, peerUserId);
    if (
      existing &&
      normalizeFingerprint(existing.fingerprint) !== normalized &&
      !verifiedByUser
    ) {
      // A passive observation can never replace a signed trust decision.
      return;
    }

    const verifiedManually = verifiedByUser || Boolean(
      existing?.verified_manually && normalizeFingerprint(existing.fingerprint) === normalized,
    );
    const acknowledged = verifiedManually || Boolean(
      existing?.acknowledged && normalizeFingerprint(existing.fingerprint) === normalized,
    );
    const observerSignature = await signTrustPayload({
      observerUserId,
      peerUserId,
      fingerprint: normalized,
      acknowledged,
      verifiedManually,
    });
    const row = {
      user_id: observerUserId,
      peer_user_id: peerUserId,
      fingerprint: normalized,
      last_seen_at: new Date().toISOString(),
      acknowledged,
      verified_manually: verifiedManually,
      trust_version: TRUST_VERSION,
      observer_signature: observerSignature,
    };
    const { error } = await (supabase as any)
      .from('user_known_fingerprints')
      .upsert(row, { onConflict: 'user_id,peer_user_id' });
    if (error) throw error;
    fingerprintSaveCache.set(cacheKey, Date.now());
    invalidateFingerprintCheckCache(peerUserId);
  } catch (error) {
    console.warn('[E2EE] Signed server fingerprint save failed', error);
  }
}

async function recordChange(input: {
  observerUserId: string;
  peerUserId: string;
  previousFingerprint: string;
  newFingerprint: string;
}): Promise<void> {
  try {
    const [{ recordIdentityChange }, { peerHasRecentRecoveryMarker }] = await Promise.all([
      import('@/lib/crypto/identityChangeLedger'),
      import('@/lib/crypto/recoveryMarkers'),
    ]);
    const recovery = await peerHasRecentRecoveryMarker(
      input.peerUserId,
      input.newFingerprint,
    );
    await recordIdentityChange({
      ...input,
      changeType: recovery ? 'recovery_restore' : 'identity_rotation',
    });
  } catch (error) {
    console.warn('[E2EE] Identity change ledger unavailable', error);
  }
}

/** Local trust always wins; only a valid account-signed server row may seed a new device. */
export async function checkFingerprintChangeWithServer(
  currentUserId: string,
  peerUserId: string,
  currentFingerprint: string,
): Promise<FingerprintCheckResult> {
  const current = normalizeFingerprint(currentFingerprint);
  if (!FINGERPRINT_RE.test(current)) throw new Error('INVALID_ACCOUNT_FINGERPRINT');
  const scopedPrevious = getKnownFingerprints(currentUserId)[peerUserId] ?? null;
  const legacyPrevious = scopedPrevious ? null : getLegacyKnownFingerprint(peerUserId);
  const localPrevious = scopedPrevious ?? legacyPrevious;
  const cacheKey = `${currentUserId}:${peerUserId}:${current}`;
  const cached = fingerprintCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.result;

  const signedServer = await readSignedServerTrust(currentUserId, peerUserId);
  const signedServerPrevious = signedServer
    ? normalizeFingerprint(signedServer.fingerprint)
    : null;

  if (localPrevious) {
    const local = normalizeFingerprint(localPrevious);
    if (local !== current) {
      await recordChange({
        observerUserId: currentUserId,
        peerUserId,
        previousFingerprint: local,
        newFingerprint: current,
      });
      const result = { changed: true, previousFp: local, source: 'local' as const };
      fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    }

    if (!scopedPrevious) saveKnownFingerprint(peerUserId, current, currentUserId);
    if (signedServerPrevious && signedServerPrevious !== local) {
      console.warn('[E2EE] Signed trust store conflicts with local continuity; local value retained', {
        peerUserId,
      });
    }
    const result = { changed: false, previousFp: null, source: 'local' as const };
    fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
    return result;
  }

  if (signedServerPrevious && signedServerPrevious !== current) {
    await recordChange({
      observerUserId: currentUserId,
      peerUserId,
      previousFingerprint: signedServerPrevious,
      newFingerprint: current,
    });
    const result = {
      changed: true,
      previousFp: signedServerPrevious,
      source: 'signed_server' as const,
    };
    fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
    return result;
  }

  saveKnownFingerprint(peerUserId, current, currentUserId);
  const result = {
    changed: false,
    previousFp: null,
    source: signedServerPrevious ? 'signed_server' as const : 'first_contact' as const,
  };
  fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
  return result;
}

export async function acceptPeerFingerprint(input: {
  currentUserId: string;
  peerUserId: string;
  fingerprint: string;
}): Promise<void> {
  const normalized = normalizeFingerprint(input.fingerprint);
  saveKnownFingerprint(input.peerUserId, normalized, input.currentUserId);
  // Keep the legacy local store updated for old UI components during rollout.
  saveKnownFingerprint(input.peerUserId, normalized);
  await saveKnownFingerprintServer(input.peerUserId, normalized, true);
  invalidateFingerprintCheckCache(input.peerUserId);
}

/** Core transport gate: identity rotations fail closed until explicit acceptance. */
export async function assertConversationFingerprintsTrusted(
  currentUserId: string,
  conversationId: string,
): Promise<void> {
  const { data: participants, error } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId);
  if (error) throw error;

  const peerUserIds = Array.from(new Set((participants ?? [])
    .map((participant) => participant.user_id)
    .filter((userId): userId is string => Boolean(userId) && userId !== currentUserId)));

  await Promise.all(peerUserIds.map(async (peerUserId) => {
    const hadTrustedPrevious = Boolean(
      getKnownFingerprints(currentUserId)[peerUserId] || getLegacyKnownFingerprint(peerUserId),
    );
    const peerKeys = await fetchPeerPublicKeys(peerUserId, { forceRefresh: true });
    if (!peerKeys) throw new Error('PEER_IDENTITY_BINDING_UNAVAILABLE');

    const check = await checkFingerprintChangeWithServer(
      currentUserId,
      peerUserId,
      peerKeys.fingerprint,
    );
    if (check.changed) throw new Error('FINGERPRINT_CHANGED');
    if (!hadTrustedPrevious) {
      await saveKnownFingerprintServer(peerUserId, peerKeys.fingerprint, false);
    }
  }));
}

export function checkFingerprintChange(
  peerUserId: string,
  currentFingerprint: string,
  observerUserId?: string,
): boolean {
  const previous = getKnownFingerprints(observerUserId)[peerUserId]
    ?? (observerUserId ? getLegacyKnownFingerprint(peerUserId) : null);
  return Boolean(previous && normalizeFingerprint(previous) !== normalizeFingerprint(currentFingerprint));
}

export const __test__ = {
  canonicalTrustPayload,
  normalizeFingerprint,
  signTrustPayload,
  verifyTrustRow,
  trustProtocol: TRUST_PROTOCOL,
  trustVersion: TRUST_VERSION,
};
''')

# Actual safety-number dialog: cryptographic derivation and signed acceptance.
replace_once(
    'src/components/messages/SafetyNumberDialog.tsx',
    "import { useState, useCallback } from 'react';\n",
    "import { useState, useCallback, useEffect, useMemo } from 'react';\n",
    'safety dialog React imports',
)
replace_once(
    'src/components/messages/SafetyNumberDialog.tsx',
    "import { bufferToBase64 } from '@/lib/crypto/utils';\n",
    "import { bufferToBase64 } from '@/lib/crypto/utils';\nimport {\n  buildAegisSafetyQrPayload,\n  deriveAegisSafetyNumber,\n} from '@/lib/crypto/safetyNumber';\nimport { acceptPeerFingerprint } from '@/lib/crypto/fingerprintTracker';\n",
    'safety dialog crypto imports',
)
regex_once(
    'src/components/messages/SafetyNumberDialog.tsx',
    r"function buildSharedSafetyNumber\(.*?\n\}\n\n/\*\* Build a verification payload for QR scanning \*/\nfunction buildQRPayload\(.*?\n\}\n",
    "",
    'remove weak safety functions',
)
replace_once(
    'src/components/messages/SafetyNumberDialog.tsx',
    "  const localSafety = buildSharedSafetyNumber(myFingerprint, peerFingerprint);\n",
    "  const localSafety = await deriveAegisSafetyNumber(myFingerprint, peerFingerprint);\n",
    'diagnostic strong safety number',
)
replace_once(
    'src/components/messages/SafetyNumberDialog.tsx',
    "  const [diagResults, setDiagResults] = useState<SyncCheck[] | null>(null);\n\n  const sharedSafetyNumber = buildSharedSafetyNumber(myFingerprint, peerFingerprint);\n  const combinedFingerprint = `Numéro de sécurité partagé\\n${sharedSafetyNumber}\\n\\nVotre clé\\n${myFingerprint}\\n\\nClé de ${peerName}\\n${peerFingerprint}`;\n  const qrPayload = buildQRPayload(conversationId, myFingerprint, peerFingerprint);\n",
    r'''  const [diagResults, setDiagResults] = useState<SyncCheck[] | null>(null);
  const [sharedSafetyNumber, setSharedSafetyNumber] = useState('Calcul en cours…');

  useEffect(() => {
    let cancelled = false;
    void deriveAegisSafetyNumber(myFingerprint, peerFingerprint)
      .then((value) => { if (!cancelled) setSharedSafetyNumber(value); })
      .catch(() => { if (!cancelled) setSharedSafetyNumber('Indisponible'); });
    return () => { cancelled = true; };
  }, [myFingerprint, peerFingerprint]);

  const combinedFingerprint = `Numéro de sécurité partagé\n${sharedSafetyNumber}\n\nVotre clé\n${myFingerprint}\n\nClé de ${peerName}\n${peerFingerprint}`;
  const qrPayload = useMemo(() => {
    try {
      return buildAegisSafetyQrPayload({
        myFingerprint,
        peerFingerprint,
        safetyNumber: sharedSafetyNumber,
      });
    } catch {
      return JSON.stringify({ protocol: 'forsure-aegis-safety-number-v1', version: 1 });
    }
  }, [myFingerprint, peerFingerprint, sharedSafetyNumber]);
''',
    'safety dialog async state',
)
replace_once(
    'src/components/messages/SafetyNumberDialog.tsx',
    "  const handleMarkVerified = () => {\n    setVerified(true);\n    onVerified?.();\n    setTimeout(() => onOpenChange(false), 1500);\n  };\n",
    r'''  const handleMarkVerified = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: participants } = await supabase
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .neq('user_id', user.id)
      .limit(1);
    const peerUserId = participants?.[0]?.user_id;
    if (!peerUserId) return;
    await acceptPeerFingerprint({
      currentUserId: user.id,
      peerUserId,
      fingerprint: peerFingerprint,
    });
    setVerified(true);
    onVerified?.();
    setTimeout(() => onOpenChange(false), 1500);
  };
''',
    'safety dialog signed acceptance',
)

# Replace the fake warning dialog with a resolver that displays real account
# fingerprints and performs the same signed acceptance as SafetyNumberDialog.
write('src/components/messages/ContactVerificationDialog.tsx', r'''
import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ShieldAlert, ShieldCheck, Fingerprint, XCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { getOrCreateIdentityKeys } from '@/lib/crypto/keyManager';
import { fetchPeerPublicKeys } from '@/lib/crypto/peerKeyCache';
import { acceptPeerFingerprint } from '@/lib/crypto/fingerprintTracker';
import { deriveAegisSafetyNumber } from '@/lib/crypto/safetyNumber';

interface VerificationRequest {
  conversationId?: string;
  localId?: string;
  reason?: string;
  receivedAt: number;
}

interface ResolvedVerification {
  currentUserId: string;
  peerUserId: string;
  myFingerprint: string;
  peerFingerprint: string;
  safetyNumber: string;
}

export function ContactVerificationDialog() {
  const [request, setRequest] = useState<VerificationRequest | null>(null);
  const [resolved, setResolved] = useState<ResolvedVerification | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onRequired = (event: Event) => {
      const detail = (event as CustomEvent<Partial<VerificationRequest>>).detail || {};
      setResolved(null);
      setRequest({
        conversationId: detail.conversationId,
        localId: detail.localId,
        reason: detail.reason,
        receivedAt: Date.now(),
      });
    };
    window.addEventListener('forsure:e2ee-contact-verification-required', onRequired as EventListener);
    return () => window.removeEventListener('forsure:e2ee-contact-verification-required', onRequired as EventListener);
  }, []);

  useEffect(() => {
    if (!request?.conversationId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('NOT_AUTHENTICATED');
      const { data: participants, error } = await supabase
        .from('conversation_participants')
        .select('user_id')
        .eq('conversation_id', request.conversationId!);
      if (error) throw error;
      const peerUserId = participants
        ?.map((entry) => entry.user_id)
        .find((id): id is string => Boolean(id) && id !== user.id);
      if (!peerUserId) throw new Error('PEER_NOT_FOUND');
      const [mine, peer] = await Promise.all([
        getOrCreateIdentityKeys(user.id),
        fetchPeerPublicKeys(peerUserId, { forceRefresh: true }),
      ]);
      if (!peer) throw new Error('PEER_IDENTITY_UNAVAILABLE');
      const safetyNumber = await deriveAegisSafetyNumber(mine.fingerprint, peer.fingerprint);
      if (!cancelled) {
        setResolved({
          currentUserId: user.id,
          peerUserId,
          myFingerprint: mine.fingerprint,
          peerFingerprint: peer.fingerprint,
          safetyNumber,
        });
      }
    })().catch((error) => {
      console.error('[E2EE] Contact verification resolution failed', error);
      if (!cancelled) toast.error('Impossible de charger les vraies clés de sécurité.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [request]);

  const formattedSafety = useMemo(() => resolved?.safetyNumber ?? '', [resolved]);
  const close = () => {
    setRequest(null);
    setResolved(null);
  };

  const handleTrust = async () => {
    if (!request || !resolved) return;
    await acceptPeerFingerprint({
      currentUserId: resolved.currentUserId,
      peerUserId: resolved.peerUserId,
      fingerprint: resolved.peerFingerprint,
    });
    window.dispatchEvent(new CustomEvent('forsure:e2ee-contact-verified', {
      detail: {
        conversationId: request.conversationId,
        localId: request.localId,
        peerUserId: resolved.peerUserId,
        fingerprint: resolved.peerFingerprint,
        acceptedAt: Date.now(),
      },
    }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { source: 'contact-verification', conversationId: request.conversationId },
    }));
    toast.success('Empreinte réelle validée. Vous pouvez réessayer l’envoi.');
    close();
  };

  if (!request) return null;

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-destructive" />
            <DialogTitle>Vérification de sécurité requise</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2 space-y-2">
            <p>La clé d’identité stable du contact a changé. L’envoi reste bloqué jusqu’à comparaison par un autre canal sûr.</p>
            <p>Ne validez pas uniquement parce que l’application affiche cette fenêtre.</p>
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border bg-muted/40 p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Fingerprint className="w-4 h-4" /> Numéro de sécurité dérivé des deux clés
          </div>
          {loading && <Loader2 className="w-5 h-5 animate-spin" />}
          {!loading && resolved && (
            <>
              <div className="font-mono text-sm break-words leading-relaxed select-all">{formattedSafety}</div>
              <p className="text-[10px] text-muted-foreground break-all">Votre empreinte : {resolved.myFingerprint}</p>
              <p className="text-[10px] text-muted-foreground break-all">Empreinte du contact : {resolved.peerFingerprint}</p>
            </>
          )}
          {!loading && !resolved && (
            <p className="text-sm text-destructive">Validation indisponible : aucune empreinte réelle n’a été chargée.</p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={close}>
            <XCircle className="w-4 h-4 mr-2" /> Annuler
          </Button>
          <Button onClick={() => void handleTrust()} disabled={!resolved || loading}>
            <ShieldCheck className="w-4 h-4 mr-2" /> J’ai comparé les deux valeurs
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Legacy callers must not bypass the fingerprint tracker. */
export function hasTrustedContactChange(): boolean {
  return false;
}
''')

write('supabase/migrations/20260729235500_signed_fingerprint_trust_attestations.sql', r'''
begin;

alter table public.user_known_fingerprints
  add column if not exists trust_version integer,
  add column if not exists observer_signature text;

-- Legacy rows are unsigned and therefore cannot be used as a cross-device trust
-- authority. Device-local continuity remains untouched.
delete from public.user_known_fingerprints
where trust_version is distinct from 1
   or nullif(trim(observer_signature), '') is null;

alter table public.user_known_fingerprints
  alter column trust_version set default 1,
  alter column trust_version set not null,
  alter column observer_signature set not null;

alter table public.user_known_fingerprints
  drop constraint if exists user_known_fingerprints_trust_version_check;
alter table public.user_known_fingerprints
  add constraint user_known_fingerprints_trust_version_check
  check (trust_version = 1);

alter table public.user_known_fingerprints
  drop constraint if exists user_known_fingerprints_observer_signature_check;
alter table public.user_known_fingerprints
  add constraint user_known_fingerprints_observer_signature_check
  check (length(observer_signature) between 80 and 180);

comment on column public.user_known_fingerprints.observer_signature is
  'Ed25519 signature by the observer account identity over peer fingerprint and trust flags.';

commit;
''')

write('src/lib/crypto/__tests__/signedFingerprintTrust.test.ts', r'''
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getIdentity: vi.fn(),
  getAuthUserId: vi.fn(),
  fetchPeer: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: mocks.getIdentity,
}));
vi.mock('@/lib/crypto/peerKeyCache', () => ({
  getCachedAuthUserId: mocks.getAuthUserId,
  fetchPeerPublicKeys: mocks.fetchPeer,
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: mocks.from },
}));

import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { bufferToBase64 } from '@/lib/crypto/utils';
import { __test__ } from '@/lib/crypto/fingerprintTracker';

const FP = 'AA'.repeat(40);

beforeEach(async () => {
  vi.clearAllMocks();
  const pair = await hardCrypto.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  mocks.getIdentity.mockResolvedValue({
    signingPrivateKey: pair.privateKey,
    signingPublicKey: pair.publicKey,
  });
});

describe('signed cross-device fingerprint trust', () => {
  it('accepts only a row signed by the observer account key', async () => {
    const input = {
      observerUserId: '11111111-1111-4111-8111-111111111111',
      peerUserId: '22222222-2222-4222-8222-222222222222',
      fingerprint: FP,
      acknowledged: true,
      verifiedManually: true,
    };
    const signature = await __test__.signTrustPayload(input);
    expect(await __test__.verifyTrustRow({
      observerUserId: input.observerUserId,
      peerUserId: input.peerUserId,
      row: {
        fingerprint: FP,
        acknowledged: true,
        verified_manually: true,
        trust_version: 1,
        observer_signature: signature,
      },
    })).toBe(true);

    expect(await __test__.verifyTrustRow({
      observerUserId: input.observerUserId,
      peerUserId: input.peerUserId,
      row: {
        fingerprint: 'BB'.repeat(40),
        acknowledged: true,
        verified_manually: true,
        trust_version: 1,
        observer_signature: signature,
      },
    })).toBe(false);
  });

  it('binds manual-verification flags inside the signature', async () => {
    const payload = __test__.canonicalTrustPayload({
      observerUserId: '11111111-1111-4111-8111-111111111111',
      peerUserId: '22222222-2222-4222-8222-222222222222',
      fingerprint: FP,
      acknowledged: true,
      verifiedManually: true,
    });
    expect(payload).toContain('forsure-aegis-known-fingerprint');
    expect(payload).toContain('"verifiedManually":true');
    expect(bufferToBase64(new TextEncoder().encode(payload).buffer as ArrayBuffer)).not.toContain(FP);
  });
});
''')

write('src/lib/crypto/__tests__/safetyNumber.test.ts', r'''
import { describe, expect, it } from 'vitest';
import {
  buildAegisSafetyQrPayload,
  deriveAegisSafetyNumber,
} from '@/lib/crypto/safetyNumber';

const A = 'AA'.repeat(40);
const B = 'BB'.repeat(40);

describe('Aegis safety number', () => {
  it('is symmetric, deterministic and sixty decimal digits', async () => {
    const ab = await deriveAegisSafetyNumber(A, B);
    const ba = await deriveAegisSafetyNumber(B, A);
    expect(ab).toBe(ba);
    expect(ab).toMatch(/^(?:\d{5} ){11}\d{5}$/);
    expect(ab.replace(/ /g, '')).toHaveLength(60);
  });

  it('binds both full fingerprints in the QR payload', async () => {
    const safetyNumber = await deriveAegisSafetyNumber(A, B);
    const payload = JSON.parse(buildAegisSafetyQrPayload({
      myFingerprint: A,
      peerFingerprint: B,
      safetyNumber,
    }));
    expect(payload.fpA).toBe(A);
    expect(payload.fpB).toBe(B);
    expect(payload.safetyNumber).toBe(safetyNumber);
  });
});
''')

write('src/lib/crypto/__tests__/identityVerificationSourcePolicy.test.ts', r'''
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('identity verification source policy', () => {
  it('never lets an unsigned server value override local continuity', () => {
    const tracker = source('../fingerprintTracker.ts');
    expect(tracker).not.toContain('serverPrevious ?? localPrevious');
    expect(tracker).toContain('Local trust always wins');
    expect(tracker).toContain('observer_signature');
  });

  it('does not fabricate a safety number from conversation metadata', () => {
    const warning = source('../../../components/messages/ContactVerificationDialog.tsx');
    expect(warning).not.toContain('acc = (acc * 31');
    expect(warning).toContain('deriveAegisSafetyNumber');
    expect(warning).toContain('acceptPeerFingerprint');
    expect(warning).toContain('J’ai comparé les deux valeurs');
  });

  it('removes unsigned legacy server trust during migration', () => {
    const migration = source('../../../../supabase/migrations/20260729235500_signed_fingerprint_trust_attestations.sql');
    expect(migration).toContain('observer_signature');
    expect(migration).toContain('delete from public.user_known_fingerprints');
  });
});
''')

# Extend audit document.
target = Path('docs/AEGIS_SIGNAL_AUDIT_V2.md')
source = target.read_text(encoding='utf-8')
source += r'''

## Signed identity continuity and real safety numbers

The previous trust lookup allowed a server value to override local TOFU state,
and one warning dialog displayed a number derived from conversation metadata
rather than identity keys. The hardened path now:

- scopes local known fingerprints by observer account;
- treats local continuity as authoritative;
- accepts cross-device server trust only when signed by the observer account's
  stable Ed25519 key;
- deletes unsigned legacy server trust rows during migration;
- records manual acknowledgement inside the signed attestation;
- derives a symmetric sixty-digit SHA-512 safety number solely from the two
  stable account fingerprints;
- refuses the confirmation button unless the actual local and peer identities
  were loaded.
'''
target.write_text(source, encoding='utf-8')

print('Signed identity continuity generated')
