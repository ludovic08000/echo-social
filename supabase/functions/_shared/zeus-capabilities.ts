export const ZEUS_CAPABILITY_IDS = [
  'activity.read',
  'messages.send',
  'calls.start',
  'posts.publish',
  'friend_requests.list',
  'friend_requests.show_profile',
  'friend_requests.respond',
  'feed.preferences.update',
  'appearance.feed.update',
] as const;

export type ZeusCapabilityId = (typeof ZEUS_CAPABILITY_IDS)[number];
export type ZeusCapabilityRisk = 'read' | 'navigate' | 'reversible' | 'sensitive';

export interface ZeusCapabilityDefinition {
  id: ZeusCapabilityId;
  risk: ZeusCapabilityRisk;
  requiresConfirmation: boolean;
  userScoped: true;
}

export const ZEUS_CAPABILITIES: Record<ZeusCapabilityId, ZeusCapabilityDefinition> = {
  'activity.read': { id: 'activity.read', risk: 'read', requiresConfirmation: false, userScoped: true },
  'messages.send': { id: 'messages.send', risk: 'sensitive', requiresConfirmation: true, userScoped: true },
  'calls.start': { id: 'calls.start', risk: 'sensitive', requiresConfirmation: true, userScoped: true },
  'posts.publish': { id: 'posts.publish', risk: 'sensitive', requiresConfirmation: true, userScoped: true },
  'friend_requests.list': { id: 'friend_requests.list', risk: 'read', requiresConfirmation: false, userScoped: true },
  'friend_requests.show_profile': { id: 'friend_requests.show_profile', risk: 'navigate', requiresConfirmation: false, userScoped: true },
  'friend_requests.respond': { id: 'friend_requests.respond', risk: 'sensitive', requiresConfirmation: true, userScoped: true },
  'feed.preferences.update': { id: 'feed.preferences.update', risk: 'reversible', requiresConfirmation: true, userScoped: true },
  'appearance.feed.update': { id: 'appearance.feed.update', risk: 'reversible', requiresConfirmation: true, userScoped: true },
};

export function getZeusCapability(id: ZeusCapabilityId): ZeusCapabilityDefinition {
  return ZEUS_CAPABILITIES[id];
}

const COMMAND_CAPABILITIES = {
  read_activity: 'activity.read',
  send_message: 'messages.send',
  start_call: 'calls.start',
  publish_post: 'posts.publish',
  list_friend_requests: 'friend_requests.list',
  show_friend_request_profile: 'friend_requests.show_profile',
  respond_friend_request: 'friend_requests.respond',
  update_feed_config: 'feed.preferences.update',
  update_feed_appearance: 'appearance.feed.update',
} as const satisfies Record<string, ZeusCapabilityId>;

export type ZeusCapabilityCommandType = keyof typeof COMMAND_CAPABILITIES;

export function capabilityForCommand(type: ZeusCapabilityCommandType): ZeusCapabilityDefinition {
  return getZeusCapability(COMMAND_CAPABILITIES[type]);
}

export function isZeusCapabilityCommand(type: unknown): type is ZeusCapabilityCommandType {
  return typeof type === 'string' && Object.hasOwn(COMMAND_CAPABILITIES, type);
}

/** Empreinte de commande, jamais de texte privé conservé dans le journal. */
export async function zeusCommandFingerprint(command: unknown, targetId?: string): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]),
    );
    return value;
  };
  // Aucune empreinte de texte privé : même un hash non salé permettrait de deviner des phrases courtes.
  const metadata = command && typeof command === 'object' && 'type' in command && command.type === 'send_message' ? { type: 'send_message' } : command;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical({ command: metadata, targetId: targetId ?? null })));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
