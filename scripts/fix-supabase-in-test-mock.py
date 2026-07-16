from pathlib import Path

path = Path('src/components/messages/__tests__/decryptionNegativeCache.test.ts')
text = path.read_text()
old = "in: async (ids: string[]) => ({"
new = "in: async (_column: string, ids: string[]) => ({"
count = text.count(old)
if count != 1:
    raise SystemExit(f'generic Supabase in mock: expected 1, found {count}')
text = text.replace(old, new, 1)
old = "in: async (ids: string[]) => {"
new = "in: async (_column: string, ids: string[]) => {"
count = text.count(old)
if count != 1:
    raise SystemExit(f'sender Supabase in mock: expected 1, found {count}')
path.write_text(text.replace(old, new, 1))
