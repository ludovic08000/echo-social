function selectSchema(spec) {
  const paths = Object.keys(spec?.paths || {})
    .filter((path) => /\/(rpc\/)?(aegis|.*device|.*conversation)/i.test(path))
    .sort();

  const definitions = spec?.definitions || spec?.components?.schemas || {};
  const tables = {};
  for (const name of ['user_devices', 'conversations', 'conversation_participants', 'messages', 'message_device_copies']) {
    const schema = definitions[name];
    if (!schema) continue;
    tables[name] = {
      required: Array.isArray(schema.required) ? schema.required : [],
      properties: Object.keys(schema.properties || {}).sort(),
    };
  }
  return { paths, tables };
}

export default async function handler(request, response) {
  if (process.env.VERCEL_ENV !== 'preview') {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '');
  if (!supabaseUrl || !anonKey) {
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'missing_configuration' }));
    return;
  }

  try {
    const upstream = await fetch(`${supabaseUrl}/rest/v1/`, {
      headers: { apikey: anonKey, accept: 'application/openapi+json' },
      redirect: 'error',
    });
    const spec = await upstream.json();
    response.statusCode = upstream.ok ? 200 : 502;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ status: upstream.status, ...selectSchema(spec) }));
  } catch {
    response.statusCode = 502;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'schema_probe_failed' }));
  }
}
