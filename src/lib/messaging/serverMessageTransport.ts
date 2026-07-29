import { supabase } from '@/integrations/supabase/client';
import { xhrFetch } from '@/lib/xhrFetch';
import type { OutboxExtra } from '@/lib/messaging/outboxVault';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const RPC_URL = `${SUPABASE_URL}/rest/v1/rpc/send_message_server`;
const RESPONSE_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;

export interface ServerMessageInput {
  messageId: string;
  conversationId: string;
  body: string;
  imageUrl?: string | null;
  extra?: OutboxExtra;
}

type ErrorPayload = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

export class ServerMessageTransportError extends Error {
  readonly code: string | null;
  readonly status: number | null;
  readonly details: string | null;

  constructor(input: {
    message: string;
    code?: string | null;
    status?: number | null;
    details?: string | null;
  }) {
    super(input.message);
    this.name = 'ServerMessageTransportError';
    this.code = input.code ?? null;
    this.status = input.status ?? null;
    this.details = input.details ?? null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function userMessageForServerError(rawMessage: string, status: number): string {
  const normalized = rawMessage.toLowerCase();

  if (
    status === 401
    || normalized.includes('not_authenticated')
    || normalized.includes('jwt')
  ) {
    return 'Session expirée — reconnectez-vous pour envoyer.';
  }
  if (
    status === 403
    || normalized.includes('sender_not_conversation_participant')
    || normalized.includes('server_message_sender_not_participant')
    || normalized.includes('server_message_sender_mismatch')
  ) {
    return 'Envoi refusé : vous ne faites plus partie de cette conversation.';
  }
  if (normalized.includes('message_rate_limited')) {
    return 'Trop de messages envoyés. Patientez quelques secondes.';
  }
  if (normalized.includes('server_message_empty')) {
    return 'Le message est vide.';
  }
  if (
    normalized.includes('server_message_too_large')
    || normalized.includes('server_message_metadata_too_large')
  ) {
    return 'Le message ou sa pièce jointe dépasse la taille autorisée.';
  }
  if (normalized.includes('message_id_conflict')) {
    return 'Conflit d’envoi détecté. Créez un nouveau message.';
  }
  if (normalized.includes('could not find the function') || normalized.includes('pgrst202')) {
    return 'Serveur de messagerie non mis à jour. La migration Supabase est requise.';
  }
  if (status >= 500) {
    return 'Serveur temporairement indisponible. Le message sera réessayé.';
  }
  return rawMessage || `Envoi refusé par le serveur (${status}).`;
}

async function parseErrorResponse(response: Response): Promise<ServerMessageTransportError> {
  let payload: ErrorPayload = {};
  let raw = '';
  try {
    raw = await response.text();
    payload = raw ? JSON.parse(raw) as ErrorPayload : {};
  } catch {
    payload = {};
  }

  const serverMessage = stringValue(payload.message)
    ?? stringValue(payload.details)
    ?? raw
    ?? `Message transport rejected (${response.status})`;

  return new ServerMessageTransportError({
    message: userMessageForServerError(serverMessage, response.status),
    code: stringValue(payload.code),
    status: response.status,
    details: [serverMessage, stringValue(payload.details), stringValue(payload.hint)]
      .filter((value): value is string => Boolean(value))
      .join(' | ') || null,
  });
}

async function readAccessToken(refresh = false): Promise<string> {
  if (refresh) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session?.access_token) return data.session.access_token;
  }

  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new ServerMessageTransportError({
      message: error?.message ?? 'Session expirée — reconnectez-vous pour envoyer.',
      code: 'NOT_AUTHENTICATED',
      status: 401,
    });
  }
  return data.session.access_token;
}

function withResponseTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new ServerMessageTransportError({
        message: 'Le serveur ne répond pas. Le message sera réessayé.',
        code: 'SERVER_MESSAGE_TRANSPORT_TIMEOUT',
      }));
    }, RESPONSE_TIMEOUT_MS);

    operation.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function postMessage(input: ServerMessageInput, accessToken: string): Promise<string> {
  // This critical send path deliberately uses XHR without an AbortSignal.
  // Browser-injected fetch wrappers and query cancellation must not abort an
  // idempotent message commit. Retrying the same stable UUID is safe server-side.
  const response = await withResponseTimeout(xhrFetch(RPC_URL, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Profile': 'public',
      'Accept-Profile': 'public',
      'X-Client-Info': 'forsure-server-message/1',
    },
    body: JSON.stringify({
      p_message_id: input.messageId,
      p_conversation_id: input.conversationId,
      p_body: input.body,
      p_image_url: input.imageUrl ?? null,
      p_extra: input.extra ?? {},
    }),
  }));

  if (!response.ok) throw await parseErrorResponse(response);

  const raw = await response.text();
  if (!raw) return input.messageId;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string' && parsed.length > 0) return parsed;
  } catch {
    if (raw.length > 0) return raw.replace(/^"|"$/g, '');
  }
  return input.messageId;
}

function retryable(error: unknown): boolean {
  if (error instanceof ServerMessageTransportError) {
    if (error.status === 401 || error.status === 403) return false;
    if (error.status !== null && error.status < 500) return false;
    return true;
  }
  return true;
}

/**
 * Idempotent server-readable message commit.
 *
 * The stable message UUID is reused for every attempt. The database RPC either
 * returns the already committed row or atomically inserts it, so a lost HTTP
 * response cannot create a duplicate message.
 */
export async function sendServerMessage(input: ServerMessageInput): Promise<string> {
  if (!input.messageId || !input.conversationId) {
    throw new ServerMessageTransportError({
      message: 'Identifiant stable du message manquant.',
      code: 'SERVER_MESSAGE_STABLE_UUID_REQUIRED',
    });
  }

  let token = await readAccessToken(false);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await postMessage(input, token);
    } catch (error) {
      lastError = error;
      const unauthorized = error instanceof ServerMessageTransportError
        && error.status === 401;

      if (unauthorized && attempt === 0) {
        token = await readAccessToken(true);
        continue;
      }

      if (attempt + 1 >= MAX_ATTEMPTS || !retryable(error)) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ServerMessageTransportError({ message: 'Échec de l’envoi.' });
}
