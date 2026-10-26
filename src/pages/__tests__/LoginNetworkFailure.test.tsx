import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { checkLoginAllowed, recordFailedLogin } from '@/lib/loginRateLimit';

const { signIn, toast, removeQueries } = vi.hoisted(() => ({
  signIn: vi.fn(),
  toast: vi.fn(),
  removeQueries: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: null, signIn }) }));
vi.mock('@/hooks/use-toast', () => ({ toast }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ removeQueries }) }));
vi.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'login.title': 'Connexion',
      'login.email': 'Email',
      'login.password': 'Mot de passe',
      'login.submit': 'Se connecter',
      'login.submitting': 'Connexion en cours',
      'login.error': 'Erreur de connexion',
      'login.errorDesc': 'Identifiants invalides',
    })[key] ?? key,
  }),
}));

import Login from '@/pages/Login';

const deviceKey = 'forsure-device-id-v1:synthetic-user';
const sessionKey = 'synthetic-unrelated-session-data';
const networkNotice = {
  title: 'Service de connexion injoignable',
  description: 'Impossible de joindre le service de connexion. Le réseau ou le serveur peut être indisponible. Réessayez sans effacer les données de votre navigateur.',
  variant: 'destructive',
};

function renderLogin() {
  render(<MemoryRouter><Login /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.invalid' } });
  fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'synthetic-test-password' } });
  const form = screen.getByRole('button', { name: /Se connecter|Verrouillé/ }).closest('form');
  if (!form) throw new Error('Login form missing');
  return form;
}

function expectDeviceDataUnchanged() {
  expect(localStorage.getItem(deviceKey)).toBe('synthetic-device');
  expect(sessionStorage.getItem(sessionKey)).toBe('preserve-me');
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(deviceKey, 'synthetic-device');
  sessionStorage.setItem(sessionKey, 'preserve-me');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('login transport failures', () => {
  it.each([
    ['fetch', new TypeError('Failed to fetch')],
    ['Safari', new TypeError('Load failed')],
    ['auth transport', Object.assign(new Error('Network request failed'), { name: 'AuthRetryableFetchError' })],
    ['timeout', Object.assign(new Error('Request expired'), { name: 'TimeoutError' })],
    ['network code', Object.assign(new Error('Unavailable'), { code: 'network_error' })],
    ['fetch code', Object.assign(new Error('Unavailable'), { code: 'fetch_error' })],
  ])('does not invent a browser blocker or server unlock for %s', async (_label, error) => {
    recordFailedLogin();
    signIn.mockResolvedValue({ error });
    fireEvent.submit(renderLogin());

    await waitFor(() => expect(toast).toHaveBeenCalledWith(networkNotice));
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeEnabled();
    expect(signIn).toHaveBeenCalledWith('test@example.invalid', 'synthetic-test-password');
    expect(checkLoginAllowed()).toBe(0);
    expect(removeQueries).not.toHaveBeenCalled();
    expectDeviceDataUnchanged();
  });

  it('handles a rejected transport request identically to a returned transport error', async () => {
    signIn.mockRejectedValue(new TypeError('Failed to fetch'));
    fireEvent.submit(renderLogin());

    await waitFor(() => expect(toast).toHaveBeenCalledWith(networkNotice));
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeEnabled();
    expect(removeQueries).not.toHaveBeenCalled();
    expectDeviceDataUnchanged();
  });

  it.each([
    ['unexpected error', new Error('Synthetic internal error')],
    ['programming TypeError', new TypeError('Cannot read properties of undefined')],
  ])('does not label an %s as a proven network outage', async (_label, error) => {
    signIn.mockRejectedValue(error);
    fireEvent.submit(renderLogin());

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Erreur de connexion',
      description: 'La connexion a échoué. Réessayez dans un instant.',
      variant: 'destructive',
    }));
    expectDeviceDataUnchanged();
    expect(removeQueries).not.toHaveBeenCalled();
  });

  it('does not misclassify a returned programming TypeError as a transport failure', async () => {
    signIn.mockResolvedValue({ error: new TypeError('Cannot read properties of undefined') });
    fireEvent.submit(renderLogin());

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Erreur de connexion' })));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: networkNotice.title }));
  });

  it('keeps the submit button disabled until a pending request completes', async () => {
    let finish!: (result: { error: Error }) => void;
    signIn.mockReturnValue(new Promise<{ error: Error }>((resolve) => { finish = resolve; }));
    fireEvent.submit(renderLogin());

    expect(screen.getByRole('button', { name: 'Connexion en cours' })).toBeDisabled();
    await act(async () => { finish({ error: new TypeError('Load failed') }); });
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeEnabled();
    expect(toast).toHaveBeenCalledWith(networkNotice);
  });
});

describe('existing login protections', () => {
  it('still counts invalid credentials and applies the local backoff on the fifth failure', async () => {
    for (let i = 0; i < 4; i++) recordFailedLogin();
    signIn.mockResolvedValue({ error: Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials' }) });
    fireEvent.submit(renderLogin());

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Erreur de connexion',
      description: 'Compte temporairement verrouillé. Réessayez dans 30s.',
    })));
    expect(checkLoginAllowed()).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Verrouillé/ })).toBeDisabled();
    expect(removeQueries).not.toHaveBeenCalled();
    expectDeviceDataUnchanged();
  });

  it('blocks a request when local backoff is already active', () => {
    for (let i = 0; i < 5; i++) recordFailedLogin();
    fireEvent.submit(renderLogin());

    expect(signIn).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Trop de tentatives' }));
    expect(checkLoginAllowed()).toBeGreaterThan(0);
    expectDeviceDataUnchanged();
  });

  it.each([
    ['email_not_confirmed', 'Email not confirmed', 400],
    ['over_request_rate_limit', 'Too many requests', 429],
  ])('preserves the provider response for %s', async (code, message, status) => {
    signIn.mockResolvedValue({ error: Object.assign(new Error(message), { code, status }) });
    fireEvent.submit(renderLogin());

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Erreur de connexion', description: message, variant: 'destructive',
    }));
    expect(removeQueries).not.toHaveBeenCalled();
    expectDeviceDataUnchanged();
  });

  it('only takes the successful-login path after signIn confirms success', async () => {
    recordFailedLogin();
    signIn.mockResolvedValue({ error: null });
    fireEvent.submit(renderLogin());

    await waitFor(() => expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['posts', 'friends-feed'] }));
    expect(toast).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('forsure-login-rl-v2')).toBeNull();
    expectDeviceDataUnchanged();
  });
});
