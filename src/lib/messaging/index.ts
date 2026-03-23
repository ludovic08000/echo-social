export type {
  MessagingProvider,
  ExternalMessage,
  ExternalConversation,
  SendMessagePayload,
  CreateConversationPayload,
} from './types';

export {
  setMessagingProvider,
  getMessagingProvider,
  hasExternalProvider,
} from './provider';

export {
  messageQueue,
  getStatusLabel,
  getStatusIcon,
  type OutboundMessage,
  type OutboundMessageStatus,
} from './messageQueue';
