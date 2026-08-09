import { describe, expect, it } from 'vitest';
import {
  buildCallInvitationPlan,
  callIdFromRoomName,
  roomNameForCall,
} from '../aegisCallProtocol';
import type { CanonicalRoutableDevice } from '@/lib/crypto/canonicalDeviceRegistry';

const CALL_ID = '018f65a7-8c4a-4bda-9f4f-f449c40f4b40';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function device(deviceId: string, isRoutable = true): CanonicalRoutableDevice {
  return {
    deviceId,
    devicePublicKey: `public-${deviceId}`,
    deviceSigningKey: `signing-${deviceId}`,
    lastSeenAt: null,
    isRoutable,
  };
}

describe('Aegis call protocol', () => {
  it('derives a LiveKit room from the immutable call UUID, never the conversation UUID', () => {
    const room = roomNameForCall(CALL_ID);
    expect(room).toBe(`call-${CALL_ID}`);
    expect(callIdFromRoomName(room)).toBe(CALL_ID);
    expect(callIdFromRoomName('call-conversation-id')).toBeNull();
  });

  it('fans the call key out to every routable canonical device deterministically', () => {
    const devices = new Map<string, readonly CanonicalRoutableDevice[]>([
      [USER_B, [device('b-device-2'), device('b-device-1')]],
      [USER_A, [device('a-device-1'), device('a-offline', false)]],
    ]);

    expect(buildCallInvitationPlan([USER_B, USER_A, USER_B], devices)).toEqual([
      {
        recipientUserId: USER_A,
        recipientDeviceId: 'a-device-1',
        recipientDevicePublicKey: 'public-a-device-1',
      },
      {
        recipientUserId: USER_B,
        recipientDeviceId: 'b-device-1',
        recipientDevicePublicKey: 'public-b-device-1',
      },
      {
        recipientUserId: USER_B,
        recipientDeviceId: 'b-device-2',
        recipientDevicePublicKey: 'public-b-device-2',
      },
    ]);
  });

  it('fails closed when one invited user has no routable device', () => {
    const devices = new Map<string, readonly CanonicalRoutableDevice[]>([
      [USER_A, [device('offline-device', false)]],
    ]);
    expect(() => buildCallInvitationPlan([USER_A], devices)).toThrow(
      `CALL_RECIPIENT_HAS_NO_ROUTABLE_DEVICE:${USER_A}`,
    );
  });

  it('rejects malformed room and call identifiers', () => {
    expect(() => roomNameForCall('not-a-uuid')).toThrow('INVALID_CALL_ID');
    expect(callIdFromRoomName(`live-${CALL_ID}`)).toBeNull();
  });
});
