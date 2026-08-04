import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createAegisServer, loadAegisConfig } from '../infra/aegis-server/server.mjs';

const config = loadAegisConfig({
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  PORT: '0',
});

const server = createAegisServer({
  config,
  logger(record) {
    process.stdout.write(`AEGIS_REMOTE_X3DH_GATEWAY ${JSON.stringify(record)}\n`);
  },
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') {
  server.close();
  throw new Error('LOCAL_GATEWAY_ADDRESS_MISSING');
}

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'vitest',
    'run',
    'src/lib/crypto/__tests__/aegisLiveRemoteX3DH.test.ts',
    '--reporter=verbose',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      AEGIS_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
    },
  },
);

const [code, signal] = await once(child, 'exit');
server.close();
await once(server, 'close').catch(() => undefined);

if (signal) {
  process.stderr.write(`Vitest terminated by signal ${signal}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = typeof code === 'number' ? code : 1;
}
