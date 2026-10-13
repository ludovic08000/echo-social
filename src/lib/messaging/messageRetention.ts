export const RETENTION_OPTIONS = [
  { value: 'immediate', label: "Dès qu’ils ont été lus", seconds: 0 },
  { value: '24h', label: '24 heures après lecture', seconds: 86400 },
  { value: '7d', label: '7 jours après lecture', seconds: 604800 },
  { value: 'never', label: 'Jamais', seconds: null },
] as const;

export type RetainedMessage = {
  id: string;
  body?: string | null;
  image_url?: string | null;
  expires_at?: string | null;
  retention_after_read_seconds?: number | null;
};

export function isMessageExpired(message: RetainedMessage, now = Date.now()): boolean {
  if (!message.expires_at) return false;
  const expiry = Date.parse(message.expires_at);
  return Number.isFinite(expiry) && expiry <= now;
}

export function retentionConfirmed(data: unknown, seconds: number | null): boolean {
  return typeof data === 'object' && data !== null
    && 'after_read' in data && data.after_read === true
    && 'seconds' in data && data.seconds === seconds;
}
