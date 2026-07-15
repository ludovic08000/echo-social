import type { Plugin } from 'vite';

/**
 * Applies the repeatable Signal/Sesame pre-key envelope to the legacy oversized
 * fan-out module without duplicating that module. Every replacement is asserted
 * so a source refactor fails the build instead of silently disabling E2EE.
 */
export function repeatablePreKeyEnvelopeGuard(): Plugin {
  return {
    name: 'forsure-repeatable-prekey-envelope-guard',
    enforce: 'pre',
    transform(code, id) {
      const cleanId = id.split('?', 1)[0].replace(/\\/g, '/');
      if (!cleanId.endsWith('/src/lib/messaging/multiDeviceFanout.ts')) return null;

      let transformed = code;
      const importAnchor = "import { captureFanoutSessionBeforeMutation } from '@/lib/messaging/fanoutSessionTransaction';";
      const repeatableImport = `import {
  acknowledgeInitiatingSessionFromRatchetPayload,
  createRepeatablePreKeyEnvelope,
  isRepeatablePreKeyEnvelope,
  prepareInitiatingSessionForSend,
  restartExpiredInitiatingSession,
  unwrapRepeatablePreKeyEnvelope,
  wrapRatchetForInitiatingSession,
} from '@/lib/messaging/repeatablePreKeyEnvelope';`;
      if (!transformed.includes(importAnchor)) {
        throw new Error('[repeatable-prekey] transaction import anchor missing');
      }
      if (!transformed.includes(repeatableImport)) {
        transformed = transformed.replace(importAnchor, `${importAnchor}\n${repeatableImport}`);
      }

      const bootstrapAnchor = `  if (isKnownInvalidDeviceId(recipientDeviceId)) return null;
  try {
    const bundle = await fetchPrekeyBundleForDevice(recipientUserId, recipientDeviceId, {`;
      const bootstrapV3 = `  if (isKnownInvalidDeviceId(recipientDeviceId)) return null;
  try {
    return await createRepeatablePreKeyEnvelope({
      plaintext,
      senderUserId,
      senderDeviceId,
      recipientUserId,
      recipientDeviceId,
      useOneTimePrekey: options.useOneTimePrekey,
    });
    const bundle = await fetchPrekeyBundleForDevice(recipientUserId, recipientDeviceId, {`;
      if (!transformed.includes('return await createRepeatablePreKeyEnvelope({')) {
        if (!transformed.includes(bootstrapAnchor)) throw new Error('[repeatable-prekey] bootstrap anchor missing');
        transformed = transformed.replace(bootstrapAnchor, bootstrapV3);
      }

      const unwrapAnchor = `  try {
    if (!payload.startsWith(X3DH_BOOTSTRAP_PREFIX_V5)) return null;

    const parsed = parseX3DHBootstrapV5(payload);`;
      const unwrapV3 = `  try {
    if (!payload.startsWith(X3DH_BOOTSTRAP_PREFIX_V5)) return null;

    if (isRepeatablePreKeyEnvelope(payload)) {
      const targetDeviceId = getCurrentDeviceId();
      return unwrapRepeatablePreKeyEnvelope({
        payload,
        recipientUserId,
        recipientDeviceId: targetDeviceId,
        senderUserId,
        senderDeviceId,
        expectedSenderIdentityKeyB64: senderIdentityKeyB64,
      });
    }

    const parsed = parseX3DHBootstrapV5(payload);`;
      if (!transformed.includes('return unwrapRepeatablePreKeyEnvelope({')) {
        if (!transformed.includes(unwrapAnchor)) throw new Error('[repeatable-prekey] unwrap anchor missing');
        transformed = transformed.replace(unwrapAnchor, unwrapV3);
      }

      const sessionPreparationAnchor = `  const senderDeviceId = input.senderDeviceId ?? getCurrentDeviceId();

  if (input.forceFreshSession) {
    await invalidateDeviceSession(input.senderUserId, senderDeviceId, input.recipientUserId, input.recipientDeviceId).catch(() => {});
  }

  let encrypted: string | null = null;`;
      const sessionPreparationV3 = `  const senderDeviceId = input.senderDeviceId ?? getCurrentDeviceId();

  if (input.forceFreshSession) {
    await restartExpiredInitiatingSession({
      myUserId: input.senderUserId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
    }).catch(() => undefined);
  } else {
    const initiatingState = await prepareInitiatingSessionForSend({
      myUserId: input.senderUserId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
    });
    if (initiatingState === 'restart') {
      await restartExpiredInitiatingSession({
        myUserId: input.senderUserId,
        myDeviceId: senderDeviceId,
        peerUserId: input.recipientUserId,
        peerDeviceId: input.recipientDeviceId,
      });
    }
  }

  let encrypted: string | null = null;`;
      if (!transformed.includes("const initiatingState = await prepareInitiatingSessionForSend({")) {
        if (!transformed.includes(sessionPreparationAnchor)) throw new Error('[repeatable-prekey] send preparation anchor missing');
        transformed = transformed.replace(sessionPreparationAnchor, sessionPreparationV3);
      }

      const ratchetReturnAnchor = `    if (encrypted && encrypted.startsWith(RATCHET_PREFIX_V5)) {
      return { encryptedBody: encrypted, senderDeviceId };
    }`;
      const ratchetReturnV3 = `    if (encrypted && encrypted.startsWith(RATCHET_PREFIX_V5)) {
      encrypted = await wrapRatchetForInitiatingSession({
        myUserId: input.senderUserId,
        myDeviceId: senderDeviceId,
        peerUserId: input.recipientUserId,
        peerDeviceId: input.recipientDeviceId,
        ratchetPayload: encrypted,
      });
      return { encryptedBody: encrypted, senderDeviceId };
    }`;
      if (!transformed.includes('encrypted = await wrapRatchetForInitiatingSession({')) {
        if (!transformed.includes(ratchetReturnAnchor)) throw new Error('[repeatable-prekey] ratchet wrap anchor missing');
        transformed = transformed.replace(ratchetReturnAnchor, ratchetReturnV3);
      }

      const identityAnchor = `      const parsed = parseX3DHBootstrapV5(row.encrypted_body);
      const { data: senderPub } = await supabase.from('user_public_keys').select('identity_key').eq('user_id', row.sender_user_id).eq('is_active', true).maybeSingle();
      if (!senderPub?.identity_key && parsed?.version !== 'v2') {`;
      const identityV3 = `      const repeatable = isRepeatablePreKeyEnvelope(row.encrypted_body);
      const parsed = repeatable ? null : parseX3DHBootstrapV5(row.encrypted_body);
      const { data: senderPub } = await supabase.from('user_public_keys').select('identity_key').eq('user_id', row.sender_user_id).eq('is_active', true).maybeSingle();
      if (!senderPub?.identity_key && !repeatable && parsed?.version !== 'v2') {`;
      if (!transformed.includes('const repeatable = isRepeatablePreKeyEnvelope(row.encrypted_body);')) {
        if (!transformed.includes(identityAnchor)) throw new Error('[repeatable-prekey] identity anchor missing');
        transformed = transformed.replace(identityAnchor, identityV3);
      }

      const acknowledgementAnchor = `      if (pt === null) {
        await invalidateDeviceSession(userId, myDeviceId, row.sender_user_id, row.sender_device_id).catch(() => {});
      }
      return {`;
      const acknowledgementV3 = `      if (pt === null) {
        await invalidateDeviceSession(userId, myDeviceId, row.sender_user_id, row.sender_device_id).catch(() => {});
      } else {
        await acknowledgeInitiatingSessionFromRatchetPayload({
          myUserId: userId,
          myDeviceId,
          peerUserId: row.sender_user_id,
          peerDeviceId: row.sender_device_id,
          ratchetPayload: row.encrypted_body,
        }).catch(() => undefined);
      }
      return {`;
      if (!transformed.includes('await acknowledgeInitiatingSessionFromRatchetPayload({')) {
        if (!transformed.includes(acknowledgementAnchor)) throw new Error('[repeatable-prekey] acknowledgement anchor missing');
        transformed = transformed.replace(acknowledgementAnchor, acknowledgementV3);
      }

      const requiredMarkers = [
        "from '@/lib/messaging/repeatablePreKeyEnvelope'",
        'return await createRepeatablePreKeyEnvelope({',
        'return unwrapRepeatablePreKeyEnvelope({',
        'const initiatingState = await prepareInitiatingSessionForSend({',
        'encrypted = await wrapRatchetForInitiatingSession({',
        'const repeatable = isRepeatablePreKeyEnvelope(row.encrypted_body);',
        'await acknowledgeInitiatingSessionFromRatchetPayload({',
      ];
      for (const marker of requiredMarkers) {
        if (!transformed.includes(marker)) {
          throw new Error(`[repeatable-prekey] required transform missing: ${marker}`);
        }
      }

      return transformed === code ? null : { code: transformed, map: null };
    },
  };
}
