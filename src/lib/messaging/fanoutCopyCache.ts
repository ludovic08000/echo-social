import { readDeviceVaultRecord, writeDeviceVaultRecord } from '@/lib/crypto/deviceVault';
import { isAegisDeviceCopyWire } from './messageCompatibility';

type CopyRecord = { digest: string; encryptedBody: string };
const validRecord = (value: unknown): value is CopyRecord => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CopyRecord>;
  return typeof record.digest === 'string' && typeof record.encryptedBody === 'string'
    && isAegisDeviceCopyWire(record.encryptedBody);
};

/** Appelé sous le verrou de la paire. Un retry réutilise le ciphertext scellé,
 * sans rembobiner Libsignal ni consommer une nouvelle clé pour la même copie. */
export async function getOrCreateFanoutCopy(args: {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  recipientDevicePublicKey: string;
  plaintext: string;
}, encrypt: () => Promise<string>): Promise<string> {
  const id = `aegis:fanout-copy:${JSON.stringify([
    args.senderUserId, args.senderDeviceId, args.messageId,
    args.recipientUserId, args.recipientDeviceId, args.recipientDevicePublicKey,
  ])}`;
  const bytes = new TextEncoder().encode(JSON.stringify([args.conversationId, args.plaintext]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const digest = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  const existing = await readDeviceVaultRecord(id, validRecord);
  if (existing) {
    if (existing.digest !== digest) throw new Error('AEGIS_FANOUT_MESSAGE_ID_CONFLICT');
    return existing.encryptedBody;
  }
  const encryptedBody = await encrypt();
  if (!isAegisDeviceCopyWire(encryptedBody)) throw new Error('AEGIS_DEVICE_COPY_WIRE_UNSUPPORTED');
  await writeDeviceVaultRecord(id, { digest, encryptedBody });
  const sealed = await readDeviceVaultRecord(id, validRecord);
  if (sealed?.digest !== digest || sealed.encryptedBody !== encryptedBody) {
    throw new Error('AEGIS_FANOUT_COPY_COMMIT_FAILED');
  }
  return encryptedBody;
}
