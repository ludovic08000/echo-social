type RecoveryCallback = () => void;

type ScheduledRecovery = {
  key: string;
  dueAt: number;
  callback: RecoveryCallback;
  generation: number;
};

const scheduled = new Map<string, ScheduledRecovery>();
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function arm(): void {
  clearTimer();
  if (scheduled.size === 0) return;

  let earliest = Number.POSITIVE_INFINITY;
  for (const task of scheduled.values()) earliest = Math.min(earliest, task.dueAt);
  const waitMs = Math.max(0, earliest - Date.now());
  timer = setTimeout(flushDue, waitMs);
}

function flushDue(): void {
  timer = null;
  const now = Date.now();
  const ready = [...scheduled.values()]
    .filter((task) => task.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt || a.generation - b.generation);

  for (const task of ready) {
    const current = scheduled.get(task.key);
    if (!current || current.generation !== task.generation) continue;
    scheduled.delete(task.key);
    try {
      task.callback();
    } catch (error) {
      console.warn('[BubbleRecoveryScheduler] retry callback failed', error);
    }
  }
  arm();
}

/**
 * Schedules one retry while keeping only one browser timeout for the whole app.
 * Re-scheduling the same key replaces its older task. The returned cleanup only
 * removes the generation created by this call.
 */
export function scheduleBubbleRecovery(
  key: string,
  delayMs: number,
  callback: RecoveryCallback,
): () => void {
  if (!key) return () => undefined;
  const task: ScheduledRecovery = {
    key,
    dueAt: Date.now() + Math.max(0, delayMs),
    callback,
    generation: ++generation,
  };
  scheduled.set(key, task);
  arm();

  return () => {
    const current = scheduled.get(key);
    if (current?.generation === task.generation) {
      scheduled.delete(key);
      arm();
    }
  };
}

export function cancelBubbleRecovery(key: string): void {
  if (!scheduled.delete(key)) return;
  arm();
}

export function wakeBubbleRecovery(key?: string): void {
  const now = Date.now();
  if (key) {
    const task = scheduled.get(key);
    if (task) scheduled.set(key, { ...task, dueAt: now });
  } else {
    for (const [taskKey, task] of scheduled) {
      scheduled.set(taskKey, { ...task, dueAt: now });
    }
  }
  arm();
}

export const __test__ = {
  reset(): void {
    clearTimer();
    scheduled.clear();
    generation = 0;
  },
  size(): number {
    return scheduled.size;
  },
  nextDueAt(): number | null {
    if (scheduled.size === 0) return null;
    return Math.min(...[...scheduled.values()].map((task) => task.dueAt));
  },
};
