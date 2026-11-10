import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

import { friendRequestProfilePath, resolveZeusFriendRequest, respondToZeusFriendRequest } from '@/lib/zeusFriendRequests';

const friendshipId = '33333333-3333-4333-8333-333333333333';
const requesterId = '22222222-2222-4222-8222-222222222222';

describe('Zeus friend request tools', () => {
  beforeEach(() => mocks.rpc.mockReset());

  it('builds a profile route only from a validated server id', () => {
    expect(friendRequestProfilePath(requesterId)).toBe(`/profile/${requesterId}`);
    expect(() => friendRequestProfilePath('javascript:alert(1)')).toThrow();
  });

  it('resolves an accented name only among server-returned pending requests', () => {
    const activity = {
      unread_messages: 0, unread_notifications: 1, publication_replies: 0, friend_requests: 2,
      checked_at: new Date().toISOString(),
      friend_requests_preview: [
        { friendship_id: friendshipId, requester_id: requesterId, name: 'Nadège Exemple', avatar_url: null },
        { friendship_id: '44444444-4444-4444-8444-444444444444', requester_id: '55555555-5555-4555-8555-555555555555', name: 'Nadège Autre', avatar_url: null },
      ],
    };
    expect(resolveZeusFriendRequest(activity, 'nadege exemple')).toHaveLength(1);
    expect(resolveZeusFriendRequest(activity, 'Nadège')).toHaveLength(2);
    expect(resolveZeusFriendRequest(activity, 'Personne inventée')).toEqual([]);
  });

  it('requires a confirmed server receipt after accepting', async () => {
    mocks.rpc.mockResolvedValue({ data: { friendship_id: friendshipId, requester_id: requesterId, decision: 'accepted' }, error: null });
    await expect(respondToZeusFriendRequest(friendshipId, 'accept')).resolves.toMatchObject({ decision: 'accepted' });
    expect(mocks.rpc).toHaveBeenCalledWith('zeus_respond_friend_request', { p_friendship_id: friendshipId, p_accept: true });
  });

  it('does not announce success when the server result is missing', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await expect(respondToZeusFriendRequest(friendshipId, 'reject')).rejects.toThrow(/pas confirmé/);
  });
});
