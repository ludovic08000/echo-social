// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
const compile = (file: string) => ts.transpileModule(readFileSync(`supabase/functions/${file}`, 'utf8').replace(/^import[^;]+;\r?\n/gm, ''), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const proposals = new Function('exports', compile('_shared/ai-admin-proposal.ts') + ';return exports;')({});
const moderation = new Function('exports', compile('_shared/owned-moderation.ts') + ';return exports;')({});
const actor = '00000000-0000-4000-8000-000000000001', contentId = '00000000-0000-4000-8000-000000000010', postId = '00000000-0000-4000-8000-000000000020';
const source = compile('zeus/index.ts');
const handles = (fetch: unknown) => new Function('Deno', 'ownedModerationContent', 'recordOwnedModeration', 'feedConfigProposal', 'proposedFeedUpdate', 'fetch', source + ';return {handleAdmin,executeZeusTool,handlePostModeration,handleCommentModeration};')(
  { env: { get: () => undefined }, serve: () => {} }, moderation.ownedModerationContent, moderation.recordOwnedModeration, proposals.feedConfigProposal, proposals.proposedFeedUpdate, fetch,
);
it('a model tool call can only propose, never change feed configuration', async () => {
  const from = vi.fn(() => { throw new Error('No database read or write expected'); });
  const result = JSON.parse(await handles(vi.fn()).executeZeusTool('update_algorithm_config', { key: 'scoring_weights', updates: { friend_boost: 9 }, reason: 'Synthetic recommendation' }, { from }));
  expect(result).toMatchObject({ applied: false, success: false, approval_required: true, proposal: { key: 'scoring_weights' } }); expect(from).not.toHaveBeenCalled();
});
it.each([
  ['unknown', { friend_boost: 9 }, 'reason'], ['scoring_weights', { friend_boost: Infinity }, 'reason'],
  ['scoring_weights', JSON.parse('{"__proto__":{"admin":true}}'), 'reason'], ['scoring_weights', [], 'reason'],
  ['scoring_weights', { friend_boost: 'nine' }, 'reason'], ['scoring_weights', { friend_boost: 9 }, ''],
  ['marketplace_injection', { positions: [1, 2.5] }, 'reason'],
])('rejects malformed proposals %s %j', (key, updates, reason) => {
  expect(proposals.feedConfigProposal(key, updates, reason)).toBeNull();
});
function adminFixture(options: { admin?: boolean; error?: boolean; applied?: unknown; roleError?: boolean; target?: boolean } = {}) {
  const writes = vi.fn();
  const rpc = vi.fn(async () => ({ data: options.applied ?? { applied: true, new_value: { friend_boost: 9 } }, error: options.error ? new Error('synthetic secret detail') : null }));
  const db = { rpc, from: (table: string) => {
    const q = { select: () => q, eq: () => q, upsert: (value: unknown) => { writes(value); return q; },
      single: async () => ({ data: { user_id: actor }, error: null }),
      maybeSingle: async () => table === 'user_roles' ? { data: options.admin === false ? null : { role: 'admin' }, error: options.roleError ? new Error('unavailable') : null }
        : table === 'profiles' ? { data: options.target === false ? null : { user_id: actor }, error: null } : { data: { value: { friend_boost: 8 } }, error: null },
    }; return q;
  } };
  const send = (body: unknown) => handles(vi.fn()).handleAdmin('synthetic', { action: 'apply_proposal', ...(body as object) }, actor, db, {});
  return { send, writes, rpc };
}
const proposal = { proposalAction: 'update_algorithm_config', key: 'scoring_weights', updates: { friend_boost: 9 }, reason: 'Human reviewed' };
it('only a verified administrator can apply the proposal', async () => {
  for (const options of [{ admin: false }, { roleError: true }]) {
    const f = adminFixture(options); expect((await f.send(proposal)).status).toBe(403); expect(f.rpc).not.toHaveBeenCalled();
  }
});
it('keeps the explicit human action but delegates the write and audit to the atomic server RPC', async () => {
  const f = adminFixture(); const response = await f.send(proposal); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, applied: true });
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('apply_admin_feed_config_update', { p_actor: actor, p_key: 'scoring_weights', p_updates: { friend_boost: 9 }, p_expected: { friend_boost: 8 }, p_reason: 'Human reviewed' });
  expect(f.writes).not.toHaveBeenCalled();
});
it('never announces success after an uncertain write, empty response or concurrent configuration change', async () => {
  for (const options of [{ error: true }, { applied: {} }, { applied: { applied: false, reason: 'FEED_CONFIG_CHANGED' } }]) {
    const response = await adminFixture(options).send(proposal); expect(response.status).toBe(options.applied && 'applied' in options.applied ? 409 : 503);
    const body = await response.text(); expect(body).not.toContain('synthetic secret detail'); expect(body).not.toContain('"success":true');
  }
});
it('refuses unknown actions, truncated identity prefixes and invalid trust scores', async () => {
  const f = adminFixture();
  expect((await f.send({ proposalAction: 'invented_operation', key: 'test', updates: {} })).status).toBe(400);
  for (const updates of [{ user_id: actor.slice(0, 12) + '...' }, { user_id: actor, trust_score: 101 }, { user_id: actor, trust_score: [] }, { user_id: actor, trust_score: 50.5 }]) {
    expect((await f.send({ proposalAction: 'whitelist_staff', key: 'trust_score_override', updates })).status).toBe(400);
  }
  expect(f.writes).not.toHaveBeenCalled();
});
function contentFixture(options: { owned?: boolean; lookupError?: boolean; rpcError?: boolean; applied?: boolean; providerValid?: boolean; canonical?: string } = {}) {
  const text = options.canonical ?? 'Texte canonique calme et respectueux.';
  const from = vi.fn((table: string) => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: options.owned === false ? null : { id: contentId, user_id: actor, post_id: postId, body: text, is_zeus_reply: false, image_url: null }, error: options.lookupError ? new Error('synthetic') : null }) }; return q;
  });
  const rpc = vi.fn(async (_name:string,_args:Record<string,unknown>) => ({ data: { applied: options.applied ?? true, reason: options.applied===false?'CONTENT_CHANGED':'Synthetic reason',severity:'warning',category:'harassment', replayed: false, strike_count: 1, escalated: false, zeus_reply: 'Be kind' }, error: options.rpcError ? new Error('synthetic') : null }));
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(init.body as string), name = payload.tools[0].function.name;
    return new Response(JSON.stringify(options.providerValid === false ? { choices: [] } : { choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify({ safe: false, category: 'harassment', severity: 'warning', reason_fr: 'Synthetic reason', reasoning: 'Synthetic analysis' }) } }] } }] }));
  });
  const send = (kind: 'post' | 'comment', body: unknown) => handles(fetch)[kind === 'post' ? 'handlePostModeration' : 'handleCommentModeration']('synthetic', body, actor, { from, rpc }, {});
  return { from, rpc, fetch, send, text };
}
it('rejects a foreign content ID or unavailable canonical lookup before calling the model', async () => {
  for (const options of [{ owned: false }, { lookupError: true }]) {
    const f = contentFixture(options); expect((await f.send('comment', { commentId: contentId, postId, text: 'fabricated' })).status).toBe(options.owned === false ? 404 : 503);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  }
});
it('uses only canonical text and canonical post linkage for the model and transactional write', async () => {
  const f = contentFixture(); const response = await f.send('comment', { commentId: contentId, postId, text: 'FORGED_BROWSER_TEXT' }); expect(response.status).toBe(200);
  const sent = JSON.parse(f.fetch.mock.calls[0][1].body as string); expect(sent.messages[1].content).toBe(f.text);
  expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_actor: actor, p_content: contentId, p_expected_body: f.text });
  expect(JSON.stringify(f.rpc.mock.calls)).not.toContain('FORGED_BROWSER_TEXT');
});
it('cannot redirect a Zeus reply into another publication', async () => {
  const f = contentFixture(); expect((await f.send('comment', { commentId: contentId, postId: contentId })).status).toBe(400); expect(f.fetch).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
});
it('does not report a confirmed strike for an edited content or failed database authority', async () => {
  for (const options of [{ applied: false }, { rpcError: true }]) {
    const f = contentFixture(options); expect((await f.send('post', { postId: contentId })).status).toBe(options.rpcError ? 503 : 409);
  }
});
it('does not claim moderation success for a malformed provider result', async () => {
  const f = contentFixture({ providerValid: false }); expect((await f.send('comment', { commentId: contentId, postId })).status).toBe(503); expect(f.rpc).not.toHaveBeenCalled();
});
it('keeps a draft preview advisory with no stored strike or system reply', async () => {
  const f = contentFixture(); const response = await f.send('post', { text: 'Preview du contenu à vérifier' }); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ safe: false, persisted: false, strike_count: 0 }); expect(f.from).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
});
