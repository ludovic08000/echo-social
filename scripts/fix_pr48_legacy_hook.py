from pathlib import Path

path = Path('src/hooks/useAegisMessageQueue.ts')
source = path.read_text(encoding='utf-8')
old = '  }, [user, conversationId, isEncryptionReady, allowPlaintext, queryClient, onPlaintextCached, onMessageSent]);'
new = '  }, [user, conversationId, _isEncryptionReady, allowPlaintext, queryClient, onPlaintextCached, onMessageSent]);'
count = source.count(old)
if count != 1:
    raise SystemExit(f'expected one stale readiness dependency, found {count}')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
