from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: anchor count={count}")
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, new: str, label: str) -> str:
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f"{label}: start missing")
    end_index = text.find(end, start_index + len(start))
    if end_index < 0:
        raise SystemExit(f"{label}: end missing")
    return text[:start_index] + new + text[end_index:]


signal_path = Path("src/hooks/useMessageQueueSignal.ts")
signal = signal_path.read_text()
signal = replace_once(
    signal,
    "import { getOrCreateIdentityKeys, exportPublicKeyBundle } from '@/lib/crypto';\n"
    "import { PROTOCOL_VERSION } from '@/lib/crypto/constants';\n"
    "import { wrapOutboundSecureMessage } from '@/lib/crypto/secureMessagePipeline';",
    "import { PROTOCOL_VERSION } from '@/lib/crypto/constants';",
    "remove discarded conversation envelope imports",
)
signal = replace_between(
    signal,
    "function encryptedPayloadKind(",
    "function toOutboundMessage(",
    "",
    "remove discarded envelope classifier",
)
signal = replace_once(
    signal,
    "  encrypt: ((plaintext: string, localId?: string) => Promise<string>) | null,",
    "  _encrypt: ((plaintext: string, localId?: string) => Promise<string>) | null,",
    "mark legacy encrypt callback unused",
)

secure_block = """    if (encryptionWasRequired) {
      if (!isEncryptionReady) {
        try {
          trace('identity_cold_start');
          await ensureUserE2EEIdentity(user.id, { waitForMaintenance: false });
          trace('identity_cold_start_ready');
        } catch (error) {
          trace('identity_cold_start_failed_non_fatal', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (requiresLongAttachment && !resumePayload?.transportPlaintext) {
        try {
          trace('long_message_upload_start', { bodyBytes: utf8ByteLength(sanitized) });
          const prepared = await prepareLongMessageForSend(sanitized, serverMessageId);
          transportPlaintext = prepared.transportBody;
          await persistOutbox({ transportPlaintext });
          trace('long_message_upload_ready', {
            previewBytes: utf8ByteLength(prepared.preview),
            transportBytes: utf8ByteLength(transportPlaintext),
          });
        } catch (longMessageError) {
          const message = longMessageError instanceof Error
            ? longMessageError.message
            : 'Préparation du message long impossible.';
          updatePending({ status: 'failed_visible', lastError: message });
          throw longMessageError instanceof Error ? longMessageError : new Error(message);
        }
      }

      // The parent is only an encrypted index. Actual content is encrypted for
      // every trusted device by buildFanoutCopies(). Never advance and discard a
      // second conversation ratchet ciphertext before that authoritative path.
      bodyToStore = resumedParent ?? buildMultiDeviceParentEnvelope(localId, traceId);
      encryptedSuccessfully = true;
      await persistOutbox({
        encryptedBody: bodyToStore,
        transportPlaintext,
        preparedCopies: resumePayload?.preparedCopies ?? [],
      });
      updatePending({ encryptedBody: bodyToStore });
      await savePlaintextForCiphertext(bodyToStore, sanitized);
      trace('encrypted_parent_ready', {
        parentBodyLength: bodyToStore.length,
        longMessage: requiresLongAttachment,
      });
    }

"""
signal = replace_between(
    signal,
    "    if (encryptionWasRequired) {",
    "    const fanoutInput = {",
    secure_block,
    "replace discarded pre-encryption path",
)

fanout_block = """    if (encryptedSuccessfully) {
      updatePending({
        status: 'waiting_secure_channel',
        serverId: serverMessageId,
        lastError: fanoutRows.length > 0
          ? 'Confirmation sécurisée de l’envoi…'
          : 'Préparation des copies chiffrées du destinataire…',
      });

      try {
        if (fanoutRows.length === 0) {
          const fanout = await buildFanoutCopies(fanoutInput);
          if (!fanout.hasTargets || fanout.rows.length === 0) {
            throw new Error('Canal sécurisé du destinataire en cours de préparation.');
          }
          fanoutRows = fanout.rows;
        }

        inlineArchiveBody = await waitForInlineArchive(archivePromise).catch(() => null);
        // Persist exact advanced envelopes before transport. Retry reuses these
        // bytes and the same UUID instead of advancing the ratchet again.
        await persistOutbox({
          transportPlaintext,
          encryptedBody: bodyToStore,
          preparedCopies: fanoutRows,
          archiveBody: inlineArchiveBody,
        });
      } catch (error) {
        await rollbackFanoutSessionTransaction(serverMessageId).catch(() => 0);
        await persistOutbox({ preparedCopies: [] }).catch(() => undefined);
        const message = error instanceof Error
          ? error.message
          : 'Canal sécurisé du destinataire en cours de préparation.';
        updatePending({ status: 'waiting_secure_channel', lastError: message }, { preparedCopies: [] });
        throw error instanceof Error ? error : new Error(message);
      }
    } else if (archiveAllowed) {
      inlineArchiveBody = await waitForInlineArchive(archivePromise).catch(() => null);
      await persistOutbox({ archiveBody: inlineArchiveBody });
    }

"""
signal = replace_between(
    signal,
    "    if (encryptedSuccessfully) {\n      updatePending({",
    "    updatePending({ status: 'sending'",
    fanout_block,
    "make fanout persistence transactional",
)
signal = signal.replace(
    "[user, conversationId, encrypt, isEncryptionReady, isEncryptionActive, allowPlaintext, queryClient, onPlaintextCached, onMessageSent]",
    "[user, conversationId, isEncryptionReady, isEncryptionActive, allowPlaintext, queryClient, onPlaintextCached, onMessageSent]",
)
signal_path.write_text(signal)


Path("src/components/messages/decryptedMediaCache.ts").write_text(
    """/**
 * Reference-counted LRU cache for decrypted media object URLs.
 * The cache owns URLs created after decryption, but never owns upload-preview
 * URLs supplied by another component.
 */

const MAX_ENTRIES = 80;

export interface DecryptedMediaEntry {
  objectUrl: string;
  isVideo: boolean;
  refs: number;
  owned: boolean;
  retired?: boolean;
  revoked?: boolean;
}

type Listener = (entry: DecryptedMediaEntry) => void;
const store = new Map<string, DecryptedMediaEntry>();
const listeners = new Map<string, Set<Listener>>();
const cloneInflight = new Map<string, Promise<void>>();

function revokeEntry(entry: DecryptedMediaEntry): void {
  if (entry.revoked || !entry.owned) return;
  entry.revoked = true;
  try { URL.revokeObjectURL(entry.objectUrl); } catch { /* browser cleanup is best-effort */ }
}

function touch(cacheKey: string, entry: DecryptedMediaEntry): void {
  store.delete(cacheKey);
  store.set(cacheKey, entry);
}

function notify(cacheKey: string, entry: DecryptedMediaEntry): void {
  listeners.get(cacheKey)?.forEach(listener => {
    try { listener(entry); } catch { /* stale subscribers must not break cache state */ }
  });
}

function retireEntry(entry: DecryptedMediaEntry): void {
  entry.retired = true;
  if (entry.refs === 0) revokeEntry(entry);
}

function trim(): void {
  if (store.size <= MAX_ENTRIES) return;
  for (const [key, entry] of store) {
    if (store.size <= MAX_ENTRIES) break;
    if (entry.refs > 0) continue;
    store.delete(key);
    cloneInflight.delete(key);
    retireEntry(entry);
  }
}

async function cloneTransientObjectUrl(cacheKey: string, sourceUrl: string, isVideo: boolean): Promise<void> {
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) return;
    const blob = await response.blob();
    const clonedUrl = URL.createObjectURL(blob);
    const current = store.get(cacheKey);
    if (!current || current.objectUrl !== sourceUrl) {
      try { URL.revokeObjectURL(clonedUrl); } catch { /* best-effort */ }
      return;
    }

    const replacement: DecryptedMediaEntry = {
      objectUrl: clonedUrl,
      isVideo,
      refs: 0,
      owned: true,
    };
    store.set(cacheKey, replacement);
    retireEntry(current);
    notify(cacheKey, replacement);
    trim();
  } catch {
    // EncryptedMedia downloads and decrypts the durable R2 object instead.
  } finally {
    cloneInflight.delete(cacheKey);
  }
}

export function getDecryptedMedia(cacheKey: string): DecryptedMediaEntry | undefined {
  const entry = store.get(cacheKey);
  if (!entry || entry.revoked) return undefined;
  touch(cacheKey, entry);
  return entry;
}

export function rememberDecryptedMedia(
  cacheKey: string,
  objectUrl: string,
  isVideo: boolean,
  transient = true,
): void {
  const existing = store.get(cacheKey);
  if (existing && !existing.revoked) {
    touch(cacheKey, existing);
    if (existing.objectUrl !== objectUrl && !transient) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* best-effort */ }
    }
    return;
  }

  const entry: DecryptedMediaEntry = {
    objectUrl,
    isVideo,
    refs: 0,
    owned: !transient,
  };
  store.set(cacheKey, entry);
  trim();

  if (transient && objectUrl.startsWith('blob:') && !cloneInflight.has(cacheKey)) {
    const task = cloneTransientObjectUrl(cacheKey, objectUrl, isVideo);
    cloneInflight.set(cacheKey, task);
  }
}

export function subscribeDecryptedMedia(cacheKey: string, listener: Listener): () => void {
  let set = listeners.get(cacheKey);
  if (!set) {
    set = new Set();
    listeners.set(cacheKey, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(cacheKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(cacheKey);
  };
}

export function retainDecryptedMedia(cacheKey: string): (() => void) | undefined {
  const entry = store.get(cacheKey);
  if (!entry || entry.revoked) return undefined;
  entry.refs += 1;
  touch(cacheKey, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.retired && entry.refs === 0) revokeEntry(entry);
    trim();
  };
}

export function releaseDecryptedMedia(cacheKey: string): void {
  const entry = store.get(cacheKey);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.retired && entry.refs === 0) revokeEntry(entry);
  trim();
}

export function forgetDecryptedMedia(cacheKey: string): void {
  const entry = store.get(cacheKey);
  if (!entry) return;
  store.delete(cacheKey);
  cloneInflight.delete(cacheKey);
  retireEntry(entry);
}

export function clearDecryptedMediaCache(): void {
  for (const entry of store.values()) retireEntry(entry);
  store.clear();
  cloneInflight.clear();
}

export const __test__ = { trim, cloneTransientObjectUrl };
"""
)

media_path = Path("src/components/messages/EncryptedMedia.tsx")
media = media_path.read_text().replace(
    "  }, [encryptedUrl, mediaCacheKey, resolvedIsVideo]);",
    "  }, [mediaCacheKey, resolvedIsVideo]);",
)
media_path.write_text(media)
