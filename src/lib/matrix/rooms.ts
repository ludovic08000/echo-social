import type { Preset } from 'matrix-js-sdk';
import { supabase } from '@/integrations/supabase/client';
import { getMatrixClient } from './client';

type RouteParticipant = {
  matrix_user_id: string;
  user_id: string;
};

type RouteResponse = {
  matrix_room_id: string | null;
  participants: RouteParticipant[];
};

async function resolveRoute(conversationId: string): Promise<RouteResponse> {
  const { data, error } = await supabase.functions.invoke<RouteResponse>('matrix-route', {
    body: { conversation_id: conversationId },
  });
  if (error) throw new Error(`MATRIX_ROUTE_FAILED: ${error.message}`);
  if (!data || !Array.isArray(data.participants)) throw new Error('MATRIX_ROUTE_INVALID');
  return data;
}

export async function ensureMatrixRoom(conversationId: string): Promise<string> {
  const client = await getMatrixClient();
  const route = await resolveRoute(conversationId);
  if (route.matrix_room_id) {
    const room = client.getRoom(route.matrix_room_id);
    if (!room || room.getMyMembership() !== 'join') {
      await client.joinRoom(route.matrix_room_id);
    }
    return route.matrix_room_id;
  }

  const ownUserId = client.getUserId();
  const invite = route.participants
    .map((participant) => participant.matrix_user_id)
    .filter((matrixUserId) => matrixUserId !== ownUserId);
  if (invite.length === 0) throw new Error('MATRIX_ROOM_HAS_NO_PEER');

  const created = await client.createRoom({
    preset: 'trusted_private_chat' as Preset,
    invite,
    is_direct: true,
    initial_state: [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
      {
        type: 'com.forsure.conversation',
        state_key: '',
        content: { conversation_id: conversationId, schema: 1 },
      },
    ],
  });

  const { data: authoritativeRoomId, error } = await supabase.rpc(
    'claim_matrix_conversation_room',
    {
      p_conversation_id: conversationId,
      p_matrix_room_id: created.room_id,
    },
  );
  if (error || !authoritativeRoomId) {
    await client.leave(created.room_id).catch(() => undefined);
    throw new Error(`MATRIX_ROOM_CLAIM_FAILED: ${error?.message ?? 'empty response'}`);
  }

  // Two participants can race to create the room. PostgreSQL chooses one;
  // leave the losing room so a conversation never has two active routes.
  if (authoritativeRoomId !== created.room_id) {
    await client.leave(created.room_id).catch(() => undefined);
  }
  return authoritativeRoomId;
}
