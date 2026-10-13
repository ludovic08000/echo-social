import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../loginSecurity', () => ({ readCurrentLoginSecuritySession: h.read }));
import { completeEmailDecision } from '../emailDecision';
const sessionId = '11111111-1111-4111-8111-111111111111';
const payload = { token: 'a'.repeat(64), decision: 'approve' as const };
const fetchMock = vi.fn();
describe('email approval remains bound to its original session', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, decision: 'approve', targetSessionId: sessionId }),
      { headers: { 'content-type': 'application/json' } }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('bounds the local session lookup if authentication storage stalls', async () => {
    vi.useFakeTimers();
    h.read.mockReturnValue(new Promise(() => undefined));
    const result = completeEmailDecision(payload);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await result).toBe('other_session');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('continues only the same server-approved session', async () => {
    h.read.mockResolvedValue({ status: 'approved', sessionId });
    expect(await completeEmailDecision(payload)).toBe('same_session');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('omit');
  });
  it.each([true,false])('reports a server-approved device without transferring its session (same=%s)', async (same) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ok:true,decision:'approve',targetSessionId:sessionId,deviceApprovalStatus:'approved'}),{headers:{'content-type':'application/json'}}));
    h.read.mockResolvedValue(same ? {status:'approved',sessionId} : null);
    expect(await completeEmailDecision(payload)).toBe(same ? 'device_approved_same_session' : 'device_approved_other_session');
  });
  it.each(['pending','revoked','unregistered','unavailable',true])('never claims device approval for status %s', async (deviceApprovalStatus) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ok:true,decision:'approve',targetSessionId:sessionId,deviceApprovalStatus}),{headers:{'content-type':'application/json'}}));
    h.read.mockResolvedValue(null);
    expect(await completeEmailDecision(payload)).toBe('other_session');
  });
  it.each([
    null,
    { status: 'approved', sessionId: '22222222-2222-4222-8222-222222222222' },
    { status: 'pending', sessionId },
    { status: 'denied', sessionId },
  ])('does not authorize a different or unapproved browser (%j)', async (current) => {
    h.read.mockResolvedValue(current);
    expect(await completeEmailDecision(payload)).toBe('other_session');
  });
  it('handles a signed-out mail browser without starting a new login', async () => {
    h.read.mockRejectedValue(new Error('not authenticated'));
    expect(await completeEmailDecision(payload)).toBe('other_session');
  });
  it('never treats a failed or legacy HTML response as success', async () => {
    fetchMock.mockResolvedValue(new Response('redirected HTML', { headers: { 'content-type': 'text/html' } }));
    await expect(completeEmailDecision(payload)).rejects.toThrow('LOGIN_EMAIL_DECISION_UNAVAILABLE');
    expect(h.read).not.toHaveBeenCalled();
  });
  it('never accepts a different decision', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, decision: 'deny', targetSessionId: sessionId }),
      { headers: { 'content-type': 'application/json' } }));
    await expect(completeEmailDecision(payload)).rejects.toThrow('LOGIN_EMAIL_DECISION_INVALID');
  });
});
