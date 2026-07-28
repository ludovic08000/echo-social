function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function getRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(
    typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined,
  );
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

async function getRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  method: string,
): Promise<BodyInit | null> {
  if (method === 'GET' || method === 'HEAD') return null;
  if (init?.body !== undefined && init.body !== null) return init.body;
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.clone().arrayBuffer();
  }
  return null;
}

function parseResponseHeaders(rawHeaders: string): Headers {
  const headers = new Headers();
  rawHeaders.trim().split(/[\r\n]+/).forEach((line) => {
    if (!line) return;
    const separator = line.indexOf(':');
    if (separator <= 0) return;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) headers.append(key, value);
  });
  return headers;
}

/**
 * Fetch-compatible transport based on XMLHttpRequest.
 *
 * Browser extensions can replace window.fetch before the application starts.
 * Supabase accepts a custom fetch implementation, so authentication can use
 * this independent browser transport when an injected fetch wrapper is broken.
 */
export async function xhrFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = getRequestUrl(input);
  const method = getRequestMethod(input, init);
  const headers = getRequestHeaders(input, init);
  const body = await getRequestBody(input, init, method);
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  const signal = init?.signal ?? request?.signal ?? null;
  const credentials = init?.credentials ?? request?.credentials ?? 'same-origin';

  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onSignalAbort);
      callback();
    };

    const onSignalAbort = () => {
      try { xhr.abort(); } catch { /* already completed */ }
      finish(() => reject(signal?.reason ?? new DOMException('Request aborted', 'AbortError')));
    };

    if (signal?.aborted) {
      onSignalAbort();
      return;
    }

    xhr.open(method, url, true);
    xhr.responseType = 'arraybuffer';
    // No client-side timeout: authentication waits for the actual network response.
    xhr.withCredentials = credentials === 'include';

    headers.forEach((value, key) => {
      try {
        xhr.setRequestHeader(key, value);
      } catch {
        // The browser owns forbidden headers such as content-length.
      }
    });

    xhr.onload = () => finish(() => {
      if (xhr.status === 0) {
        reject(new TypeError('Network request failed'));
        return;
      }

      const statusWithoutBody = xhr.status === 101
        || xhr.status === 204
        || xhr.status === 205
        || xhr.status === 304;
      const responseBody = statusWithoutBody ? null : (xhr.response ?? null);

      resolve(new Response(responseBody, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: parseResponseHeaders(xhr.getAllResponseHeaders()),
      }));
    });

    xhr.onerror = () => finish(() => reject(new TypeError('Network request failed')));
    xhr.onabort = () => finish(() => reject(signal?.reason ?? new DOMException('Request aborted', 'AbortError')));

    if (signal) signal.addEventListener('abort', onSignalAbort, { once: true });

    try {
      xhr.send(body as XMLHttpRequestBodyInit | Document | null);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
