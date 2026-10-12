export type CallInvitationContext = {
  callId: string;
  conversationId: string;
  callerId: string;
  callType: 'audio' | 'video';
  isGroup: boolean;
  recipientUserId: string;
  recipientDeviceId: string;
};

/** La signature lie l'émetteur, le destinataire et la clé enveloppée au même
 * appel. Elle ne signe jamais une clé média en clair et ne remplace aucune identité. */
export function callInvitationProofPayload(
  context: CallInvitationContext,
  callerDeviceId: string,
  unsignedEnvelope: string,
): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-call-invitation',
    callId: context.callId,
    conversationId: context.conversationId,
    callerId: context.callerId,
    callerDeviceId,
    callType: context.callType,
    isGroup: context.isGroup,
    recipientUserId: context.recipientUserId,
    recipientDeviceId: context.recipientDeviceId,
    unsignedEnvelope,
  });
}
