import { readFileSync, writeFileSync } from 'node:fs';

function replaceExact(path, oldText, newText, expected = 1) {
  const source = readFileSync(path, 'utf8');
  const matches = source.split(oldText).length - 1;
  if (matches !== expected) {
    throw new Error(`${path}: expected ${expected} exact match(es), found ${matches}`);
  }
  writeFileSync(path, source.replace(oldText, newText), 'utf8');
}

const useCallPath = 'src/hooks/useCall.ts';
let useCall = readFileSync(useCallPath, 'utf8');
const liveKitImport = "import { getLiveKitToken } from '@/lib/livekit';\n";
if (!useCall.includes("@/lib/messaging/currentDevice")) {
  if (!useCall.includes(liveKitImport)) throw new Error('useCall LiveKit import anchor missing');
  useCall = useCall.replace(
    liveKitImport,
    `${liveKitImport}import { getCurrentDeviceId, hydrateDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';\n`,
  );
}
const useCallReplacements = [
  [
    'const startCall = useCallback(async (conversationId: string, type: CallType, e2eeKeyB64: string) => {',
    'const startCall = useCallback(async (callId: string, type: CallType, e2eeKeyB64: string) => {',
  ],
  [
    'console.info(`[CALL] starting ${type} call for conversation ${conversationId}`);',
    'console.info(`[CALL] starting ${type} call ${callId}`);',
  ],
  [
    "      const roomName = `call-${conversationId}`;\n      const { token, url } = await getLiveKitToken(roomName, true);",
    "      const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());\n      if (!deviceId || isDeviceIdTemporary()) {\n        throw new Error('Current device is not ready for a secure call');\n      }\n      const roomName = `call-${callId}`;\n      const { token, url } = await getLiveKitToken(roomName, true, deviceId);",
  ],
];
for (const [oldText, newText] of useCallReplacements) {
  const matches = useCall.split(oldText).length - 1;
  if (matches !== 1) throw new Error(`useCall replacement mismatch: ${oldText}`);
  useCall = useCall.replace(oldText, newText);
}
writeFileSync(useCallPath, useCall, 'utf8');

replaceExact(
  'src/App.tsx',
  'call.startCall(accepted.conversation_id, accepted.call_type, accepted.decryptedCallKey);',
  'call.startCall(accepted.id, accepted.call_type, accepted.decryptedCallKey);',
);

const widgetPath = 'src/components/ChatWidget.tsx';
let widget = readFileSync(widgetPath, 'utf8');
const widgetReplacements = [
  ['await call.startCall(conversationId, type, callKey);', 'await call.startCall(callId, type, callKey);'],
  [
    'onCallStarted={async (_callId, _roomId, callKey, callType) => {',
    'onCallStarted={async (callId, _roomId, callKey, callType) => {',
  ],
  [
    'await call.startCall(conversationId, callType, callKey);',
    'await call.startCall(callId, callType, callKey);',
  ],
  [
    "await call.startCall(conversationId, 'audio', callKey);",
    "await call.startCall(callId, 'audio', callKey);",
  ],
  [
    "await call.startCall(conversationId, 'video', callKey);",
    "await call.startCall(callId, 'video', callKey);",
  ],
];
for (const [oldText, newText] of widgetReplacements) {
  const matches = widget.split(oldText).length - 1;
  if (matches !== 1) throw new Error(`ChatWidget replacement mismatch: ${oldText}`);
  widget = widget.replace(oldText, newText);
}
writeFileSync(widgetPath, widget, 'utf8');

replaceExact(
  'docs/AEGIS_CLEAN_REBUILD.md',
  '5. Call-scoped LiveKit rooms, invitations and per-device call-key delivery.',
  '5. ⏳ Call-scoped LiveKit rooms, invitations and per-device call-key delivery — implementation complete, validation pending.',
);

const finalUseCall = readFileSync(useCallPath, 'utf8');
const finalWidget = readFileSync(widgetPath, 'utf8');
if (finalUseCall.includes('`call-${conversationId}`')) throw new Error('conversation-scoped call room remains');
if (finalWidget.includes('call.startCall(conversationId')) throw new Error('conversation-scoped UI call join remains');
