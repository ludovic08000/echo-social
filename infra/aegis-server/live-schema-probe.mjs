const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const anonKey = String(process.env.SUPABASE_ANON_KEY || '');
if (!supabaseUrl || !anonKey) throw new Error('Missing public Supabase configuration');

const response = await fetch(`${supabaseUrl}/rest/v1/`, {
  headers: {
    apikey: anonKey,
    authorization: `Bearer ${anonKey}`,
    accept: 'application/openapi+json',
  },
  redirect: 'error',
});
if (!response.ok) {
  const detail = await response.text().catch(() => '');
  throw new Error(`OpenAPI request failed: ${response.status} ${detail.slice(0, 200)}`);
}
const spec = await response.json();
const paths = spec.paths || {};
const definitions = spec.definitions || spec.components?.schemas || {};

function compactPath(path, value) {
  const post = value?.post || value?.get || null;
  const parameters = Array.isArray(post?.parameters)
    ? post.parameters.map((parameter) => ({
        name: parameter.name,
        in: parameter.in,
        required: Boolean(parameter.required),
        schema: parameter.schema || null,
      }))
    : [];
  return { path, parameters };
}

const rpc = Object.entries(paths)
  .filter(([path]) => path.startsWith('/rpc/') && /(aegis|device|conversation)/i.test(path))
  .map(([path, value]) => compactPath(path, value))
  .sort((a, b) => a.path.localeCompare(b.path));

const tables = {};
for (const name of ['user_devices', 'conversations', 'conversation_participants', 'messages', 'message_device_copies']) {
  const schema = definitions[name];
  if (!schema) continue;
  tables[name] = {
    required: Array.isArray(schema.required) ? schema.required : [],
    properties: Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, {
      type: value.type || null,
      format: value.format || null,
      default: value.default ?? null,
    }])),
  };
}

console.log('AEGIS_LIVE_SCHEMA_PROBE_START');
console.log(JSON.stringify({ rpc, tables }, null, 2));
console.log('AEGIS_LIVE_SCHEMA_PROBE_END');
