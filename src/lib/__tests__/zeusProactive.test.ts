import { describe, expect, it } from 'vitest';
import { buildZeusBreakReminder, buildZeusLoginBriefing } from '@/lib/zeusProactive';

describe('Zeus proactive messages', () => {
  it('returns nothing when the account has no unread activity', () => {
    expect(buildZeusLoginBriefing({ unreadMessages: 0, unreadNotifications: [] })).toBeNull();
  });

  it('aggregates activity without exposing actor names or content', () => {
    const result = buildZeusLoginBriefing({
      unreadMessages: 2,
      unreadNotifications: [
        { type: 'message' },
        { type: 'comment' },
        { type: 'comment' },
        { type: 'reaction' },
      ],
    });
    expect(result).toBe('Bonjour ! Tu as 2 messages non lus, 2 réponses à tes publications et 1 nouvelle réaction.');
    expect(result).not.toContain('message notification');
  });

  it('uses the configured active-time threshold in the wellbeing reminder', () => {
    expect(buildZeusBreakReminder(15)).toContain('15 minutes');
  });
});
