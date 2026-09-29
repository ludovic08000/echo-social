import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reactionMocks = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

vi.mock('@/hooks/useReactions', () => ({
  REACTION_EMOJIS: {
    like: '👍',
    love: '❤️',
    haha: '😂',
    wow: '😮',
    sad: '😢',
    angry: '😠',
  },
  REACTION_LABELS: {
    like: "J'aime",
    love: "J'adore",
    haha: 'Haha',
    wow: 'Wow',
    sad: 'Triste',
    angry: 'Grrr',
  },
  useAddReaction: () => ({
    isPending: false,
    mutate: reactionMocks.mutate,
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

import { ReactionButton } from '@/components/ReactionButton';

describe('ReactionButton', () => {
  beforeEach(() => {
    reactionMocks.mutate.mockReset();
  });

  it('opens the picker without adding another reaction', () => {
    render(
      <ReactionButton
        postId="post-1"
        currentReaction="love"
        reactionsCount={8}
        variant="facebook"
      />,
    );

    const trigger = screen.getByRole('button', {
      name: /Réaction actuelle : J'adore/i,
    });
    expect(trigger).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(trigger);

    expect(reactionMocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitemradio', { name: "J'adore" })).toBeDisabled();
  });

  it('replaces the selected reaction once and locks concurrent clicks', () => {
    render(
      <ReactionButton
        postId="post-1"
        currentReaction="love"
        reactionsCount={8}
        variant="facebook"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Réaction actuelle/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Wow' }));

    expect(reactionMocks.mutate).toHaveBeenCalledTimes(1);
    expect(reactionMocks.mutate.mock.calls[0][0]).toEqual({
      postId: 'post-1',
      reactionType: 'wow',
      previousReaction: 'love',
    });

    fireEvent.click(screen.getByRole('button', { name: /Réaction actuelle : Wow/i }));
    expect(reactionMocks.mutate).toHaveBeenCalledTimes(1);
  });
});
