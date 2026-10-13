import { beforeEach, afterEach, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const ctx = { state: 'suspended', resume: vi.fn(async () => { ctx.state = 'running'; }) };
  const Constructor = vi.fn(function () { return ctx; });
  vi.stubGlobal('window', { AudioContext: Constructor });
  return { ctx, Constructor };
}

it('resumes a suspended context and shares it between alerts', async () => {
  const { ctx, Constructor } = setup();
  const audio = await import('../notificationAudio');
  expect(await audio.resumeNotificationAudio()).toBe(ctx);
  expect(await audio.resumeNotificationAudio()).toBe(ctx);
  expect(Constructor).toHaveBeenCalledTimes(1);
  expect(ctx.resume).toHaveBeenCalledTimes(1);
});

it('recreates a closed context', async () => {
  const { ctx, Constructor } = setup();
  const audio = await import('../notificationAudio');
  audio.getNotificationAudioContext(); ctx.state = 'closed';
  audio.getNotificationAudioContext();
  expect(Constructor).toHaveBeenCalledTimes(2);
});

it('contains playback refusals instead of rejecting the notification handler', async () => {
  const { ctx } = setup(); ctx.resume.mockRejectedValue(new Error('NotAllowedError'));
  const audio = await import('../notificationAudio');
  expect(await audio.resumeNotificationAudio()).toBeNull();
});

it('supports the legacy WebKit constructor', async () => {
  const { ctx, Constructor } = setup();
  vi.stubGlobal('window', { webkitAudioContext: Constructor });
  const audio = await import('../notificationAudio');
  expect(await audio.resumeNotificationAudio()).toBe(ctx);
});

it('installs one set of gesture listeners and cleans up only after the last consumer', async () => {
  setup();
  const add = vi.spyOn(document, 'addEventListener');
  const remove = vi.spyOn(document, 'removeEventListener');
  const audio = await import('../notificationAudio');
  const first = audio.installNotificationAudioUnlock();
  const second = audio.installNotificationAudioUnlock();
  expect(add.mock.calls.filter(([name]) => ['pointerdown','touchend','keydown'].includes(name))).toHaveLength(3);
  first(); first(); expect(remove).not.toHaveBeenCalled();
  second(); expect(remove).toHaveBeenCalledTimes(3);
});
