from pathlib import Path
import re

path = Path('src/components/ChatWidget.tsx')
source = path.read_text(encoding='utf-8')


def replace_once(old: str, new: str, label: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    source = source.replace(old, new, 1)


replace_once(
    "import { EncryptionBadge, EncryptionStatusBar } from '@/components/messages/EncryptionBadge';",
    "import { EncryptionBadge } from '@/components/messages/EncryptionBadge';",
    'badge import',
)

pattern = re.compile(
    r"  // E2EE integration — STRICT: plaintext allowed only for the Zeus bot\.\n"
    r"  const e2ee = useE2EE\(conversationId, peerUserId\);\n"
    r"  // Policy, not readiness: every human conversation is always Aegis\. During\n"
    r"  // cold key hydration the outbox waits; it must never fall back to plaintext\.\n"
    r"  const isEncryptionActive = !isZeusConversation;"
)
source, count = pattern.subn(
    "  // Keep the legacy decryptor mounted for historical Aegis rows and for\n"
    "  // account identity used by LiveKit call-key wrapping. New text messages\n"
    "  // use the authenticated server transport and never wait for peer devices.\n"
    "  const e2ee = useE2EE(conversationId, peerUserId);\n"
    "  const hasLegacyEncryptedHistory = !isZeusConversation;",
    source,
    count=1,
)
if count != 1:
    raise SystemExit(f'encryption policy block: expected 1, found {count}')

source, count = re.subn(
    r"(  const queue = useMessageQueue\(\n    conversationId,\n)"
    r"    e2ee\.encrypt,\n    e2ee\.isReady\(\),\n    isEncryptionActive,",
    r"\1    null,\n    true,\n    hasLegacyEncryptedHistory,",
    source,
    count=1,
)
if count != 1:
    raise SystemExit(f'queue args: expected 1, found {count}')

source, count = re.subn(
    r"      if \(!isZeusConversation && e2ee\.peerKeyMissing\) \{\n"
    r"        toast\.error\('Clés du contact indisponibles\.'\);\n"
    r"        return;\n      \}\n",
    '',
    source,
    count=1,
)
if count != 1:
    raise SystemExit(f'document peer-key guard: expected 1, found {count}')

replace_once(
    '  // Wrap upload: encrypt media before upload when E2EE is active',
    '  // Media blobs remain encrypted before upload. Their key travels inside\n'
    '  // the authenticated server message, so this is storage protection rather\n'
    '  // than end-to-end secrecy from ForSure.',
    'media comment',
)
replace_once(
    '  }, [isZeusConversation, rawUpload, conversationId, sendMessage, queue, e2ee.peerKeyMissing, viewOnceArmed]);',
    '  }, [isZeusConversation, rawUpload, conversationId, sendMessage, queue, viewOnceArmed]);',
    'media dependencies',
)
replace_once(
    'isEncryptionActive={isEncryptionActive}',
    'isEncryptionActive={hasLegacyEncryptedHistory}',
    'legacy body decrypt prop',
)
replace_once(
    '      {/* E2EE Status bar removed per user request — encryption is silent */}',
    '      {/* Text messages use authenticated server transport. LiveKit calls\n'
    '          keep their independent E2EE indicator inside CallOverlay. */}',
    'status comment',
)
replace_once(
    '      {/* Identity and route preparation stay silent. Aegis retries its\n'
    '          encrypted device-copy outbox when peer keys become available. */}',
    '      {/* Historical Aegis rows can still be decrypted locally. New sends do\n'
    '          not prepare device routes or wait for peer keys. */}',
    'route comment',
)
replace_once(
    '      // Fire-and-forget: queue handles retry/encryption in background',
    '      // Fire-and-forget: the queue owns durable, idempotent server retry.',
    'send comment',
)
path.write_text(source, encoding='utf-8')

queue_path = Path('src/hooks/useAegisMessageQueue.ts')
queue = queue_path.read_text(encoding='utf-8')


def queue_replace(old: str, new: str, label: str) -> None:
    global queue
    count = queue.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    queue = queue.replace(old, new, 1)


queue_replace('  isEncryptionReady: boolean,', '  _isEncryptionReady: boolean,', 'readiness parameter')
queue_replace(
    '        encryptionWasRequested: !allowPlaintext,\n        isEncryptionReady,',
    '        serverTransport: !allowPlaintext,',
    'trace semantics',
)
queue_replace(
    '    // Plaintext is a policy exception reserved for Zeus. Readiness flags are\n'
    '    // deliberately ignored here: a cold peer route must wait in the encrypted\n'
    '    // outbox and can never downgrade the request body sent to the server.\n'
    '    const encryptionWasRequired = !allowPlaintext;',
    '    // Zeus keeps its existing system-message path. Every human conversation\n'
    '    // uses the idempotent authenticated server RPC. Compatibility names stay\n'
    '    // in place only while historical Aegis rows remain readable.\n'
    '    const encryptionWasRequired = !allowPlaintext;',
    'delivery policy comment',
)
queue_replace(
    '      // The Zeus exception keeps its own durable outbox lifecycle. Encrypted\n'
    '      // peer traffic is persisted exclusively by the Aegis engine below.',
    '      // Zeus keeps its existing system-message lifecycle.',
    'Zeus comment',
)
queue_replace('        encryptedSuccessfully = true;', '        encryptedSuccessfully = false;', 'post-send decrypt flag')
queue_path.write_text(queue, encoding='utf-8')
