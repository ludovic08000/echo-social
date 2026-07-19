import { beforeEach, describe, expect, it, vi } from 'vitest';

const r2State = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  uploadCalls: 0,
}));

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

vi.mock('@/lib/r2', () => ({
  uploadToR2: vi.fn(async (file: File | Blob, _category: string, customFileName?: string) => {
    r2State.uploadCalls += 1;
    const path = `uploads/${customFileName || 'body.enc'}`;
    const url = `https://r2.example.test/${encodeURIComponent(path)}`;
    r2State.objects.set(url, new Uint8Array(await readBlob(file)));
    return { url, path };
  }),
  fetchR2Object: vi.fn(async (url: string) => {
    const bytes = r2State.objects.get(url);
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(bytes.slice(), {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    });
  }),
}));

import {
  MAX_INLINE_MESSAGE_BODY_BYTES,
  MAX_LONG_MESSAGE_BODY_BYTES,
  isInlineMessageBody,
  parseLongMessageManifest,
  prepareLongMessageForSend,
  resolveLongMessageBody,
  trimUtf8ToBytes,
  utf8ByteLength,
} from '../longMessageAttachment';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';

function variedBody(minBytes: number): string {
  const unit = 'Aegis protège ce message long 🔐 — ligne utile.\n';
  let value = '';
  while (utf8ByteLength(value) <= minBytes) value += unit;
  return value;
}

describe('Signal-style long message attachments', () => {
  beforeEach(() => {
    r2State.objects.clear();
    r2State.uploadCalls = 0;
  });

  it('measures the inline threshold in UTF-8 bytes rather than JS characters', () => {
    expect(utf8ByteLength('a'.repeat(2_048))).toBe(2_048);
    expect(utf8ByteLength('🙂'.repeat(512))).toBe(2_048);
    expect(isInlineMessageBody('🙂'.repeat(512))).toBe(true);
    expect(isInlineMessageBody('🙂'.repeat(513))).toBe(false);
  });

  it('trims a preview without splitting a surrogate pair', () => {
    const value = `${'a'.repeat(2_046)}🙂fin`;
    const preview = trimUtf8ToBytes(value);
    expect(utf8ByteLength(preview)).toBeLessThanOrEqual(MAX_INLINE_MESSAGE_BODY_BYTES);
    expect(preview.endsWith('\ud83d')).toBe(false);
    expect(preview.endsWith('\ude42')).toBe(false);
  });

  it('keeps bodies up to 2 KiB inline without an upload', async () => {
    const body = '🙂'.repeat(512);
    const prepared = await prepareLongMessageForSend(body, MESSAGE_ID);
    expect(prepared).toEqual({ transportBody: body, isLong: false, preview: body });
    expect(r2State.uploadCalls).toBe(0);
  });

  it('encrypts one complete long body attachment and round-trips it', async () => {
    const body = variedBody(MAX_INLINE_MESSAGE_BODY_BYTES);
    const prepared = await prepareLongMessageForSend(body, MESSAGE_ID);

    expect(prepared.isLong).toBe(true);
    expect(r2State.uploadCalls).toBe(1);
    const manifest = parseLongMessageManifest(prepared.transportBody);
    expect(manifest).not.toBeNull();
    expect(manifest?.id).toBe(MESSAGE_ID);
    expect(manifest?.size).toBe(utf8ByteLength(body));
    expect(utf8ByteLength(manifest?.preview ?? '')).toBeLessThanOrEqual(MAX_INLINE_MESSAGE_BODY_BYTES);

    const encryptedBlob = r2State.objects.get(manifest!.url);
    expect(encryptedBlob).toBeTruthy();
    expect(new TextDecoder().decode(encryptedBlob)).not.toContain('Aegis protège');

    await expect(resolveLongMessageBody(prepared.transportBody, MESSAGE_ID)).resolves.toBe(body);
  });

  it('binds the encrypted attachment to the immutable message id', async () => {
    const prepared = await prepareLongMessageForSend(variedBody(MAX_INLINE_MESSAGE_BODY_BYTES), MESSAGE_ID);
    await expect(
      resolveLongMessageBody(prepared.transportBody, '22222222-2222-4222-8222-222222222222'),
    ).rejects.toThrow(/autre identifiant/i);
  });

  it('rejects a body above Signal long-attachment ceiling', async () => {
    const body = variedBody(MAX_LONG_MESSAGE_BODY_BYTES);
    expect(utf8ByteLength(body)).toBeGreaterThan(MAX_LONG_MESSAGE_BODY_BYTES);
    await expect(prepareLongMessageForSend(body, MESSAGE_ID)).rejects.toThrow(/64 Kio/i);
    expect(r2State.uploadCalls).toBe(0);
  });
});
