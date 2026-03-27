/**
 * Client-side anti-spam utilities for messaging.
 * Protects against rapid-fire messages, duplicate spam, and link flooding.
 * 
 * v2 — Relaxed to avoid blocking legitimate usage:
 * - Cooldown reduced to 300ms (was 1s)
 * - Duplicate window reduced to 5s (was 30s) — only catches true rapid spam
 * - Rate limit raised to 30/min (was 15)
 */

const MESSAGE_COOLDOWN_MS = 300; // 300ms between messages (typing speed safe)
const MAX_MESSAGES_PER_MINUTE = 30;
const MAX_MESSAGE_LENGTH = 2000;
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

  // Duplicate detection (only within very short window to catch double-clicks)
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
