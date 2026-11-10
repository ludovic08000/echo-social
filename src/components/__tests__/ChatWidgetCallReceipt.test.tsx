import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatWidgetProvider, useChatWidget } from '../ChatWidgetContext';

const request = { actorId: 'owner', recipientId: 'peer', conversationId: 'conversation', type: 'audio' as const };
afterEach(() => vi.useRealTimers());

it('opens the correct conversation and waits for the matching call receipt', async () => {
  const { result } = renderHook(() => useChatWidget(), { wrapper: ChatWidgetProvider });
  let receipt!: Promise<string>;
  const done = vi.fn();
  act(() => { receipt = result.current.requestCall(request); });
  receipt.then(done);
  expect(result.current.state).toMatchObject({ isOpen: true, conversationId: 'conversation' });
  const id = result.current.pendingCall!.id;
  act(() => result.current.settleCall('other-call'));
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  expect(result.current.pendingCall?.id).toBe(id);
  await act(async () => { result.current.settleCall(id); await receipt; });
  expect(done).toHaveBeenCalledWith('L’appel a été lancé.');
  expect(result.current.pendingCall).toBeNull();
});

it('rejects duplicate requests and cancels a pending request when the widget closes', async () => {
  const { result } = renderHook(() => useChatWidget(), { wrapper: ChatWidgetProvider });
  let receipt!: Promise<string>;
  act(() => { receipt = result.current.requestCall(request); });
  const outcome = receipt.catch(error => error.message);
  await expect(result.current.requestCall(request)).rejects.toThrow(/déjà en cours/);
  await act(async () => { result.current.closeChat(); await outcome; });
  expect(await outcome).toMatch(/annulé/);
  expect(result.current.pendingCall).toBeNull();
});

it('treats an absent media receipt as unknown rather than a successful call', async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useChatWidget(), { wrapper: ChatWidgetProvider });
  let receipt!: Promise<string>;
  act(() => { receipt = result.current.requestCall(request); });
  const outcome = receipt.catch(error => error.message);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(await outcome).toMatch(/n’a pas été confirmé/);
  expect(result.current.pendingCall).toBeNull();
});
