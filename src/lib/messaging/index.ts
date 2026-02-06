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
