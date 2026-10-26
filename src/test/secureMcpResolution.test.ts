import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { secureMcpPlugin } from '../../scripts/secure-mcp';

const state = vi.hoisted(() => ({ nested: false, options: undefined as Record<string, unknown> | undefined }));
vi.mock('esbuild', () => ({
  build: vi.fn(async (options: Record<string, unknown>) => {
    state.options = options;
    return {
      metafile: {
        inputs: { [state.nested ? 'node_modules/.deno/@modelcontextprotocol+sdk@1.31.0/node_modules/@modelcontextprotocol/sdk/index.js' : 'node_modules/@modelcontextprotocol/sdk/index.js']: {} },
        outputs: {},
      },
      outputFiles: [],
    };
  }),
}));
vi.mock('node:fs/promises', () => {
  const mocked = {
    readFile: vi.fn(async (path: string) => path.endsWith('config.toml') ? 'project_id = "testproject"' : '{"version":"1.32.1"}'),
    realpath: vi.fn(async (path: string) => path),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

async function configure() {
  const hook = secureMcpPlugin().configResolved;
  if (typeof hook !== 'function') throw new Error('Expected configResolved hook');
  await hook.call({} as never, { root: '/project' } as never);
}

describe('audited MCP SDK resolution', () => {
  it('forces transitive SDK imports to the audited root', async () => {
    state.nested = false;
    await configure();
    expect(state.options?.alias).toEqual({ '@modelcontextprotocol/sdk': resolve('/project/node_modules/@modelcontextprotocol/sdk/dist/esm') });
  });
  it('still rejects a nested Deno SDK in bundle inputs', async () => {
    state.nested = true;
    await expect(configure()).rejects.toThrow('MCP_UNEXPECTED_NESTED_SDK');
  });
});