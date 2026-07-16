from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE | re.DOTALL)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 regex anchor, found {count}")
    return updated


# Every normal rendered message already carries sender_id. Thread it into the
# decrypt service and keep one simple cached fallback for unusual callers. This
# removes the per-wave timer, pending callback arrays and sender batch machinery.
path = Path('src/components/messages/decryptionService.ts')
text = path.read_text()
text = regex_once(
    text,
    r"const BATCH_WINDOW_MS = 50;\nconst senderBatchPending = .*?\nfunction getSenderIdBatched\(messageId: string\): Promise<string \| null> \{.*?\n\}\n",
    """const senderCache = new LruMap<string, string>(500);

async function getSenderId(messageId: string): Promise<string | null> {
  const cached = senderCache.get(messageId);
  if (cached !== undefined) return cached;
  try {
    const { data } = await supabase
      .from('messages')
      .select('id,sender_id')
      .in('id', [messageId]);
    const senderId = ((data as Array<{ id: string; sender_id: string | null }> | null) ?? [])
      .find((row) => row.id === messageId)?.sender_id ?? null;
    if (senderId) senderCache.set(messageId, senderId);
    return senderId;
  } catch {
    return null;
  }
}
""",
    'replace sender lookup machinery',
)
text = replace_once(
    text,
    "        if (!senderId) senderId = await getSenderIdBatched(messageId);\n",
    "        if (!senderId) senderId = await getSenderId(messageId);\n",
    'use direct cached sender lookup',
)
path.write_text(text)


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


for file_path, label in [
    ('src/components/messages/ChatView.tsx', 'chat view sender id'),
    ('src/components/ChatWidget.tsx', 'chat widget sender id'),
]:
    path = Path(file_path)
    text = path.read_text()
    text = regex_once(
        text,
        r'(?P<indent>^[ \t]+)messageId=\{msg\.id\}\n(?P=indent)hasMedia=\{!!msg\.image_url\}',
        r'\g<indent>messageId={msg.id}\n\g<indent>senderId={msg.sender_id}\n\g<indent>hasMedia={!!msg.image_url}',
        label,
    )
    path.write_text(text)
