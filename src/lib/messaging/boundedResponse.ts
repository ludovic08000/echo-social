/**
 * Read a Response without allowing an untrusted attachment to allocate beyond
 * the protocol limit. With Content-Length, one exact buffer is allocated and
 * filled incrementally; unknown-length responses remain bounded while read.
 */
export async function readResponseArrayBufferBounded(
  response: Response,
  maxBytes: number,
  expectedBytes?: number,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('ATTACHMENT_LIMIT_INVALID');
  }

  const header = response.headers.get('content-length');
  const announced = header === null ? null : Number(header);
  if (
    announced !== null &&
    (!Number.isSafeInteger(announced) || announced < 0 || announced > maxBytes)
  ) {
    throw new Error('ATTACHMENT_TOO_LARGE');
  }
  if (
    expectedBytes !== undefined &&
    (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes)
  ) {
    throw new Error('ATTACHMENT_EXPECTED_SIZE_INVALID');
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error('ATTACHMENT_TOO_LARGE');
    if (expectedBytes !== undefined && buffer.byteLength !== expectedBytes) {
      throw new Error('ATTACHMENT_SIZE_MISMATCH');
    }
    return buffer;
  }

  const reader = response.body.getReader();
  try {
    if (announced !== null) {
      const bytes = new Uint8Array(announced);
      let offset = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > announced || offset + value.byteLength > maxBytes) {
          throw new Error('ATTACHMENT_SIZE_MISMATCH');
        }
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      if (offset !== announced || (expectedBytes !== undefined && offset !== expectedBytes)) {
        throw new Error('ATTACHMENT_SIZE_MISMATCH');
      }
      return bytes.buffer;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('ATTACHMENT_TOO_LARGE');
      chunks.push(value);
    }
    if (expectedBytes !== undefined && total !== expectedBytes) {
      throw new Error('ATTACHMENT_SIZE_MISMATCH');
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
