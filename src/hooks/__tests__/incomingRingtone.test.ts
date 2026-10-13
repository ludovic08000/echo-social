import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock('@/lib/notificationAudio', () => ({ resumeNotificationAudio: mock.resume, installNotificationAudioUnlock: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/calls/aegisCallProtocol', () => ({}));
import { createRingtone } from '../useIncomingCall';
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function readyContext() {
  const oscillator = { type: '', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const gain = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn() };
  return { currentTime: 0, destination: {}, createOscillator: vi.fn(() => oscillator), createGain: vi.fn(() => gain) };
}

it('rings repeatedly but never doubles its timer, then stops', async () => {
  vi.useFakeTimers(); const ctx = readyContext(); mock.resume.mockResolvedValue(ctx);
  const ringtone = createRingtone(); ringtone.play(); ringtone.play();
  await Promise.resolve(); expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1800); expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  ringtone.stop(); vi.advanceTimersByTime(4000);
  expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
});

it('does not restart after accept or decline while resume was pending', async () => {
  vi.useFakeTimers(); const ctx = readyContext(); let finish!: (value: unknown) => void;
  mock.resume.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const ringtone = createRingtone(); ringtone.play(); ringtone.stop(); finish(ctx);
  await Promise.resolve(); vi.advanceTimersByTime(5000);
  expect(ctx.createOscillator).not.toHaveBeenCalled();
});
