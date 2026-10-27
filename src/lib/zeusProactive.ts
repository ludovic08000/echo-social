import type { Notification } from '@/hooks/useNotifications';

export interface ZeusBriefingInput {
  unreadMessages: number;
  unreadNotifications: Pick<Notification, 'type'>[];
}

function plural(count: number, singular: string, pluralForm: string) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Builds a privacy-preserving briefing: no actor name, message body or post
 * content is exposed in a notification that may be visible over the shoulder.
 */
export function buildZeusLoginBriefing({
  unreadMessages,
  unreadNotifications,
}: ZeusBriefingInput): string | null {
  const counts = new Map<Notification['type'], number>();
  for (const notification of unreadNotifications) {
    counts.set(notification.type, (counts.get(notification.type) ?? 0) + 1);
  }

  // Message notifications and conversation unread counters can describe the
  // same event. The conversation counter is authoritative for messages.
  const parts: string[] = [];
  if (unreadMessages > 0) {
    parts.push(plural(unreadMessages, 'message non lu', 'messages non lus'));
  }

  const comments = counts.get('comment') ?? 0;
  const reactions = (counts.get('reaction') ?? 0) + (counts.get('like') ?? 0);
  const friendRequests = counts.get('friend_request') ?? 0;
  const friendAccepted = counts.get('friend_accepted') ?? 0;
  const sales = counts.get('sale') ?? 0;

  if (comments > 0) parts.push(plural(comments, 'réponse à une publication', 'réponses à tes publications'));
  if (reactions > 0) parts.push(plural(reactions, 'nouvelle réaction', 'nouvelles réactions'));
  if (friendRequests > 0) parts.push(plural(friendRequests, "demande d’ami", "demandes d’amis"));
  if (friendAccepted > 0) parts.push(plural(friendAccepted, 'demande acceptée', 'demandes acceptées'));
  if (sales > 0) parts.push(plural(sales, 'notification de vente', 'notifications de vente'));

  if (parts.length === 0) return null;
  if (parts.length === 1) return `Bonjour ! Tu as ${parts[0]}.`;

  const last = parts.pop();
  return `Bonjour ! Tu as ${parts.join(', ')} et ${last}.`;
}

export function buildZeusBreakReminder(activeMinutes: number): string {
  return `Tu es actif depuis environ ${activeMinutes} minutes. Pour ton bien-être, une petite pause, quelques pas ou un verre d’eau pourraient te faire du bien.`;
}

