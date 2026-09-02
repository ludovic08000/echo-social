export { getMatrixConfig, type MatrixConfig } from './config';
export { getMatrixClient, stopMatrixClient } from './client';
export { downloadMatrixMedia } from './media';
export {
  downloadMatrixAttachment,
  listMatrixMessages,
  sendMatrixAttachment,
  sendMatrixText,
  subscribeMatrixMessages,
  type MatrixMessage,
} from './messages';
export { ensureMatrixRoom } from './rooms';
export { requestMatrixSession, type MatrixSession } from './session';
