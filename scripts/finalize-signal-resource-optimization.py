from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, found {count}")
    return text.replace(old, new, 1)


# Batch sender metadata in the same microtask instead of keeping a 50 ms timer
# alive for every message wave. Known sender ids bypass the lookup entirely.
path = Path('src/components/messages/decryptionService.ts')
text = path.read_text()
text = replace_once(
    text,
    "const BATCH_WINDOW_MS = 50;\nconst senderBatchPending = new Map<string, Array<(value: string | null) => void>>();\n",
    "const senderBatchPending = new Map<string, Array<(value: string | null) => void>>();\n",
    'remove sender batch delay',
)
text = replace_once(
    text,
    "let senderBatchTimer: ReturnType<typeof setTimeout> | null = null;\n\nasync function flushSenderBatch(): Promise<void> {\n  senderBatchTimer = null;\n",
    "let senderBatchScheduled = false;\n\nasync function flushSenderBatch(): Promise<void> {\n  senderBatchScheduled = false;\n",
    'sender batch scheduled flag',
)
text = replace_once(
    text,
    "    if (!senderBatchTimer) {\n      senderBatchTimer = setTimeout(() => void flushSenderBatch(), BATCH_WINDOW_MS);\n    }\n",
    "    if (!senderBatchScheduled) {\n      senderBatchScheduled = true;\n      queueMicrotask(() => void flushSenderBatch());\n    }\n",
    'sender batch microtask',
)
path.write_text(text)


# Thread the sender already present on each message row into the decrypt service.
# This avoids a Supabase sender lookup for normal rendered messages.
path = Path('src/components/messages/DecryptedMessageBody.tsx')
text = path.read_text()
text = replace_once(
    text,
    "  messageId?: string;\n  hasMedia?: boolean;\n",
    "  messageId?: string;\n  senderId?: string | null;\n  hasMedia?: boolean;\n",
    'decrypted body sender prop type',
)
text = replace_once(
    text,
    "  refreshKey,\n  messageId,\n  hasMedia,\n",
    "  refreshKey,\n  messageId,\n  senderId,\n  hasMedia,\n",
    'decrypted body sender prop destructure',
)
text = replace_once(
    text,
    "    void resolvePlaintext({ body, messageId, isMe, decrypt })\n",
    "    void resolvePlaintext({ body, messageId, senderId, isMe, decrypt })\n",
    'resolve plaintext sender prop',
)
text = replace_once(
    text,
    "  }, [body, messageId, cachedPlaintext, retryTick, refreshKey]);\n",
    "  }, [body, messageId, senderId, cachedPlaintext, retryTick, refreshKey]);\n",
    'decryption effect sender dependency',
)
path.write_text(text)


path = Path('src/components/messages/ChatView.tsx')
text = path.read_text()
text = replace_once(
    text,
    "                              messageId={msg.id}\n                              hasMedia={!!msg.image_url}\n",
    "                              messageId={msg.id}\n                              senderId={msg.sender_id}\n                              hasMedia={!!msg.image_url}\n",
    'chat view sender id',
)
path.write_text(text)


path = Path('src/components/ChatWidget.tsx')
text = path.read_text()
text = replace_once(
    text,
    "                               messageId={msg.id}\n                               hasMedia={!!msg.image_url}\n",
    "                               messageId={msg.id}\n                               senderId={msg.sender_id}\n                               hasMedia={!!msg.image_url}\n",
    'chat widget sender id',
)
path.write_text(text)
