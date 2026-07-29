
import {
  isAegisAmbiguousTransportFailure,
  sendMessageWithAegisRetry,
} from '@/lib/messaging/aegisSendRpc';
import {
  MAX_INLINE_MESSAGE_BODY_BYTES,
  prepareLongMessageForSend,
  utf8ByteLength,
} from '@/lib/messaging/longMessageAttachment';

export const aegisTransportModule = {
  sendWithRetry: sendMessageWithAegisRetry,
  isAmbiguousFailure: isAegisAmbiguousTransportFailure,
  maxInlineBodyBytes: MAX_INLINE_MESSAGE_BODY_BYTES,
  prepareLongMessage: prepareLongMessageForSend,
  utf8ByteLength,
} as const;

export type AegisTransportModule = typeof aegisTransportModule;

export {
  isAegisAmbiguousTransportFailure,
  sendMessageWithAegisRetry,
  MAX_INLINE_MESSAGE_BODY_BYTES,
  prepareLongMessageForSend,
  utf8ByteLength,
};
