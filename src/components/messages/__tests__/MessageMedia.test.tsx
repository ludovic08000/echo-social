import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MessageMedia } from '../MessageMedia';

const IMAGE_URL = 'https://cdn.example.test/raw-photo.jpg';

function decryptResult(overrides: Record<string, unknown> = {}) {
  return {
    text: '',
    incompatible: true,
    encrypted: true,
    verified: false,
    ...overrides,
  } as any;
}

describe('MessageMedia E2EE rendering', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('does not render the raw media URL when encryption is active and no media key is available', async () => {
    const decrypt = vi.fn();
    const { container } = render(
      <MessageMedia
        imageUrl={IMAGE_URL}
        body="Photo"
        decrypt={decrypt}
        isEncryptionActive
        messageId="msg-no-key"
      />,
    );

    expect(await screen.findByText('Media chiffre en attente')).toBeInTheDocument();
    expect(container.querySelector(`img[src="${IMAGE_URL}"]`)).toBeNull();
    expect(container.querySelector(`video[src="${IMAGE_URL}"]`)).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('renders raw media only for non-E2EE messages', () => {
    const { container } = render(
      <MessageMedia
        imageUrl={IMAGE_URL}
        body="Photo"
        decrypt={vi.fn()}
        isEncryptionActive={false}
      />,
    );

    expect(container.querySelector(`img[src="${IMAGE_URL}"]`)).not.toBeNull();
  });

  it('treats x3dh5 bodies as encrypted even when the active conversation flag is unavailable', async () => {
    vi.useFakeTimers();
    const decrypt = vi.fn().mockResolvedValue(decryptResult());
    const { container } = render(
      <MessageMedia
        imageUrl={IMAGE_URL}
        body="x3dh5.session.dh.0.0.iv.ct"
        decrypt={decrypt}
        isEncryptionActive={false}
        messageId="msg-v5"
      />,
    );

    expect(container.querySelector(`img[src="${IMAGE_URL}"]`)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(screen.getByText('Media chiffre en attente')).toBeInTheDocument();
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(container.querySelector(`img[src="${IMAGE_URL}"]`)).toBeNull();
  });
});
