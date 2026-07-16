from pathlib import Path

path = Path('src/components/messages/decryptionService.ts')
text = path.read_text()
old = """    inflight.set(key, promise);
    promise.finally(() => inflight.delete(key));
  }

  return promise;
}
"""
new = """    const tracked = promise.finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
    inflight.set(key, tracked);
    promise = tracked;
  }

  return promise;
}
"""
count = text.count(old)
if count != 1:
    raise SystemExit(f'inflight cleanup anchor: expected 1, found {count}')
path.write_text(text.replace(old, new, 1))
