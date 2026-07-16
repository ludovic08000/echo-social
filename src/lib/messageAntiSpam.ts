/**
 * Client-side anti-spam utilities for messaging.
 * Protects against rapid-fire messages, duplicate spam, and link flooding.
 *
 * Length follows Signal's long-message envelope: the logical UTF-8 body may be
 * up to 64 KiB; transport decides whether it stays inline or becomes an
 * encrypted text attachment.
 */

import {
  MAX_LONG_MESSAGE_BODY_BYTES,
  utf8ByteLength,
} from '@/lib/messaging/longMessageAttachment';

const MESSAGE_COOLDOWN_MS = 300; // 300ms between messages (typing speed safe)
const MAX_MESSAGES_PER_MINUTE = 30;
const MAX_LINKS_PER_MESSAGE = 3;
const DUPLICATE_WINDOW_MS = 5_000; // 5 seconds — only catches instant double-sends

interface MessageRecord {
  body: string;
  timestamp: number;
}

const recentMessages: MessageRecord[] = [];
let lastSentAt = 0;

function cleanOldRecords() {
  const cutoff = Date.now() - 60_000;
  while (recentMessages.length && recentMessages[0].timestamp < cutoff) {
    recentMessages.shift();
  }
}

export function validateMessage(body: string): { valid: boolean; error?: string } {
  const trimmed = body.trim();

  // Empty
  if (!trimmed) {
    return { valid: false, error: 'Le message ne peut pas être vide.' };
  }

  // Signal-compatible long-body limit: bytes, not JavaScript characters.
  const bodyBytes = utf8ByteLength(trimmed);
  if (bodyBytes > MAX_LONG_MESSAGE_BODY_BYTES) {
    return {
      valid: false,
      error: `Le message est trop long (maximum ${MAX_LONG_MESSAGE_BODY_BYTES / 1024} Kio en UTF-8).`,
    };
  }

  // Cooldown
  const now = Date.now();
  if (now - lastSentAt < MESSAGE_COOLDOWN_MS) {
    return { valid: false, error: 'Vous envoyez des messages trop rapidement.' };
  }

  // Rate limit
  cleanOldRecords();
  if (recentMessages.length >= MAX_MESSAGES_PER_MINUTE) {
    return { valid: false, error: 'Limite de messages atteinte. Patientez un instant.' };
  }

  // Duplicate detection (only within very short window to catch double-clicks)
  const duplicateCutoff = now - DUPLICATE_WINDOW_MS;
  const isDuplicate = recentMessages.some(
    (r) => r.timestamp > duplicateCutoff && r.body === trimmed,
  );
  if (isDuplicate) {
    return { valid: false, error: 'Message identique déjà envoyé.' };
  }

  // Link spam detection
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const links = trimmed.match(urlPattern);
  if (links && links.length > MAX_LINKS_PER_MESSAGE) {
    return { valid: false, error: 'Trop de liens dans un seul message.' };
  }

  // Suspicious patterns (repetitive characters)
  const repeatingChars = /(.)\1{19,}/; // 20+ same character in a row
  if (repeatingChars.test(trimmed)) {
    return { valid: false, error: 'Message suspect détecté.' };
  }

  return { valid: true };
}

export function recordSentMessage(body: string) {
  const now = Date.now();
  lastSentAt = now;
  recentMessages.push({ body: body.trim(), timestamp: now });
  cleanOldRecords();
}

export function sanitizeMessageBody(body: string): string {
  return body.trim();
}
