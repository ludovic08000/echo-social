from pathlib import Path

path = Path('src/components/messages/decryptionService.ts')
text = path.read_text()
old = """    const { data } = await supabase
      .from('messages')
      .select('id,sender_id')
      .in('id', ids);
    const map = new Map<string, string>();
"""
new = """    const { data } = await supabase
      .from('messages')
      .select('id,sender_id')
      .in('id', ids);
    console.info('[SENDER_BATCH_TRACE]', { ids, data });
    const map = new Map<string, string>();
"""
count = text.count(old)
if count != 1:
    raise SystemExit(f'batch anchor: expected 1, found {count}')
path.write_text(text.replace(old, new, 1))
