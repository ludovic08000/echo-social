/**
 * Client-side anti-spam utilities for messaging.
 * Protects against rapid-fire messages, duplicate spam, and link flooding.
 */

const MESSAGE_COOLDOWN_MS = 1000; // 1 second between messages
const MAX_MESSAGES_PER_MINUTE = 15;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_LINKS_PER_MESSAGE = 3;
const DUPLICATE_WINDOW_MS = 30_000; // 30 seconds

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

  // Length
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { valid: false, error: `Le message est trop long (max ${MAX_MESSAGE_LENGTH} caractères).` };
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

  // Duplicate detection
  const duplicateCutoff = now - DUPLICATE_WINDOW_MS;
  const isDuplicate = recentMessages.some(
    (r) => r.timestamp > duplicateCutoff && r.body === trimmed
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
  return body.trim().slice(0, MAX_MESSAGE_LENGTH);
}
