/*
 * Signal-style recovery coordinator for unresolved message bubbles.
 *
 * Signal Desktop runs retryable work through bounded job managers instead of
 * letting every view create its own independent timer storm. On the web the
 * message rows are already durable in Supabase, so this coordinator only owns
 * scheduling: jobs are recreated when durable messages mount again.
 */

const MAX_CONCURRENT_RECOVERIES = 3;
const RETRY_DELAYS_MS = [500, 1_500, 4_000, 8_000, 15_000, 30_000] as const;

type RecoveryCallback = () => void;

type RecoveryJob = {
  key: string;
  callbacks: Set<RecoveryCallback>;
  priority: number;
  attempt: number;
  nextAttemptAt: number;
  running: boolean;
  createdAt: number;
};

const jobs = new Map<string, RecoveryJob>();
let activeJobs = 0;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let pumping = false;

function clearWakeTimer(): void {
  if (wakeTimer !== null) clearTimeout(wakeTimer);
  wakeTimer = null;
}

function nextDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

function schedulePump(): void {
  clearWakeTimer();
  if (jobs.size === 0) return;

  const now = Date.now();
  let earliest = Number.POSITIVE_INFINITY;
  for (const job of jobs.values()) {
    if (job.running || job.callbacks.size === 0) continue;
    earliest = Math.min(earliest, job.nextAttemptAt);
  }

  if (!Number.isFinite(earliest)) return;
  const delay = Math.max(0, earliest - now);
  wakeTimer = setTimeout(() => void pump(), delay);
}

async function runJob(job: RecoveryJob): Promise<void> {
  job.running = true;
  activeJobs += 1;

  try {
    // Copy first: a callback may unregister itself while React processes state.
    for (const callback of [...job.callbacks]) {
      try {
        callback();
      } catch {
        // One broken bubble must not stall recovery for the conversation.
      }
    }
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
    job.running = false;

    const current = jobs.get(job.key);
    if (current === job && job.callbacks.size > 0) {
      job.attempt += 1;
      job.nextAttemptAt = Date.now() + nextDelay(job.attempt);
    }
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  clearWakeTimer();

  try {
    while (activeJobs < MAX_CONCURRENT_RECOVERIES) {
      const now = Date.now();
      const next = [...jobs.values()]
        .filter(job => !job.running && job.callbacks.size > 0 && job.nextAttemptAt <= now)
        .sort((a, b) =>
          b.priority - a.priority ||
          a.nextAttemptAt - b.nextAttemptAt ||
          a.createdAt - b.createdAt,
        )[0];

      if (!next) break;
      void runJob(next).finally(() => {
        pumping = false;
        void pump();
      });
    }
  } finally {
    pumping = false;
    schedulePump();
  }
}

export function registerDecryptRecovery(
  key: string,
  callback: RecoveryCallback,
  options: { priority?: number } = {},
): () => void {
  if (!key) return () => {};

  let job = jobs.get(key);
  if (!job) {
    job = {
      key,
      callbacks: new Set(),
      priority: options.priority ?? 0,
      attempt: 0,
      nextAttemptAt: Date.now() + nextDelay(0),
      running: false,
      createdAt: Date.now(),
    };
    jobs.set(key, job);
  }

  job.callbacks.add(callback);
  job.priority = Math.max(job.priority, options.priority ?? 0);
  void pump();

  return () => {
    const current = jobs.get(key);
    if (!current) return;
    current.callbacks.delete(callback);
    if (current.callbacks.size === 0 && !current.running) jobs.delete(key);
    schedulePump();
  };
}

export function wakeDecryptRecovery(key?: string, resetAttempts = false): void {
  const now = Date.now();
  if (key) {
    const job = jobs.get(key);
    if (!job) return;
    if (resetAttempts) job.attempt = 0;
    job.nextAttemptAt = now;
  } else {
    for (const job of jobs.values()) {
      if (resetAttempts) job.attempt = 0;
      job.nextAttemptAt = now;
    }
  }
  void pump();
}

export function getDecryptRecoveryAttempt(key: string): number {
  return jobs.get(key)?.attempt ?? 0;
}

if (typeof window !== 'undefined') {
  const wakeAll = () => wakeDecryptRecovery(undefined, false);
  window.addEventListener('online', wakeAll);
  window.addEventListener('focus', wakeAll);
}

export const __test__ = {
  reset(): void {
    clearWakeTimer();
    jobs.clear();
    activeJobs = 0;
    pumping = false;
  },
};
