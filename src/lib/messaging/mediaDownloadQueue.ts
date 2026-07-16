/*
 * Bounded attachment download queue inspired by Signal Desktop's
 * AttachmentDownloadManager: deduplicated jobs, three concurrent downloads,
 * visible-first priority and exponential retry. Durable message metadata lives
 * in Supabase, so jobs can be reconstructed safely after a reload.
 */

const MAX_CONCURRENT_DOWNLOADS = 3;
const RETRY_DELAYS_MS = [0, 1_000, 5_000, 30_000, 5 * 60_000] as const;

type DownloadTask = () => Promise<void>;

type DownloadJob = {
  key: string;
  task: DownloadTask;
  priority: number;
  attempt: number;
  nextAttemptAt: number;
  running: boolean;
  createdAt: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
};

const jobs = new Map<string, DownloadJob>();
let activeJobs = 0;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let pumping = false;

function clearWakeTimer(): void {
  if (wakeTimer !== null) clearTimeout(wakeTimer);
  wakeTimer = null;
}

function schedulePump(): void {
  clearWakeTimer();
  if (jobs.size === 0) return;

  let earliest = Number.POSITIVE_INFINITY;
  for (const job of jobs.values()) {
    if (job.running) continue;
    earliest = Math.min(earliest, job.nextAttemptAt);
  }
  if (!Number.isFinite(earliest)) return;

  wakeTimer = setTimeout(() => void pump(), Math.max(0, earliest - Date.now()));
}

function removeJob(key: string): void {
  jobs.delete(key);
  schedulePump();
}

async function runJob(job: DownloadJob): Promise<void> {
  job.running = true;
  activeJobs += 1;

  try {
    await job.task();
    removeJob(job.key);
    job.resolve();
  } catch (error) {
    job.attempt += 1;
    if (job.attempt >= RETRY_DELAYS_MS.length) {
      removeJob(job.key);
      job.reject(error);
    } else {
      job.nextAttemptAt = Date.now() + RETRY_DELAYS_MS[job.attempt];
    }
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
    job.running = false;
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  clearWakeTimer();

  try {
    while (activeJobs < MAX_CONCURRENT_DOWNLOADS) {
      const now = Date.now();
      const next = [...jobs.values()]
        .filter(job => !job.running && job.nextAttemptAt <= now)
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

export function queueMediaDownload(
  key: string,
  task: DownloadTask,
  options: { priority?: number } = {},
): Promise<void> {
  const existing = jobs.get(key);
  if (existing) {
    existing.priority = Math.max(existing.priority, options.priority ?? 0);
    existing.task = task;
    existing.nextAttemptAt = Math.min(existing.nextAttemptAt, Date.now());
    void pump();
    return existing.promise;
  }

  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A component may unmount while the durable job continues. Prevent an
  // unhandled rejection; active subscribers still receive the same promise.
  promise.catch(() => {});

  const job: DownloadJob = {
    key,
    task,
    priority: options.priority ?? 0,
    attempt: 0,
    nextAttemptAt: Date.now(),
    running: false,
    createdAt: Date.now(),
    resolve,
    reject,
    promise,
  };
  jobs.set(key, job);
  void pump();
  return promise;
}

export function retryMediaDownloadNow(key: string): void {
  const job = jobs.get(key);
  if (!job) return;
  job.attempt = 0;
  job.nextAttemptAt = Date.now();
  void pump();
}

export function cancelQueuedMediaDownload(key: string): void {
  const job = jobs.get(key);
  if (!job || job.running) return;
  jobs.delete(key);
  job.reject(new DOMException('Download cancelled', 'AbortError'));
  schedulePump();
}

export function hasQueuedMediaDownload(key: string): boolean {
  return jobs.has(key);
}

if (typeof window !== 'undefined') {
  const wake = () => {
    const now = Date.now();
    for (const job of jobs.values()) job.nextAttemptAt = now;
    void pump();
  };
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
}

export const __test__ = {
  reset(): void {
    clearWakeTimer();
    for (const job of jobs.values()) {
      job.reject(new DOMException('Reset', 'AbortError'));
    }
    jobs.clear();
    activeJobs = 0;
    pumping = false;
  },
};
