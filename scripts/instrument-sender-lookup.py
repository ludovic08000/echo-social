from pathlib import Path

path = Path('src/components/messages/decryptionService.ts')
text = path.read_text()
old = """        if (!senderId) senderId = await getSenderIdBatched(messageId);
        if (senderId) {
"""
new = """        if (!senderId) senderId = await getSenderIdBatched(messageId);
        console.info('[SENDER_LOOKUP_TRACE]', { messageId, senderId, inflightMatch: inflight.has(key), negativeHit: negCacheHit(key) });
        if (senderId) {
"""
count = text.count(old)
if count != 1:
    raise SystemExit(f'sender lookup anchor: expected 1, found {count}')
path.write_text(text.replace(old, new, 1))
