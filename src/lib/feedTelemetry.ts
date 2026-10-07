import type { FeedSignalType } from './recsysV8';

export interface ServedFeedEvent {
  event_id: string;
  post_id: string;
  exposure_id: string;
  event_type: FeedSignalType;
  dwell_ms?: number;
}

/** Bounded memory, stable IDs across retries, one request at a time. */
export class FeedEventQueue {
  private pending: ServedFeedEvent[] = [];
  private flushing = false;
  private generation = 0;
  dropped = 0;
  constructor(private readonly capacity = 1000) {}
  get size() { return this.pending.length; }
  get busy() { return this.flushing; }
  push(event: ServedFeedEvent) {
    if (this.pending.length >= this.capacity) { this.dropped++; return; }
    this.pending.push(event);
  }
  clear() { this.pending = []; this.generation++; }
  async flush(send: (events: ServedFeedEvent[]) => Promise<void>): Promise<boolean> {
    if (this.flushing || !this.pending.length) return true;
    this.flushing = true;
    const generation = this.generation;
    const batch = this.pending.splice(0, 100);
    try {
      await send(batch);
      return true;
    } catch {
      if (generation === this.generation) this.pending = [...batch, ...this.pending].slice(0, this.capacity);
      return false;
    } finally { this.flushing = false; }
  }
}

export function dwellSignal(ms: number): FeedSignalType | null {
  if (ms >= 3000) return 'dwell_long';
  if (ms >= 1200) return 'dwell_medium';
  if (ms > 0 && ms < 800) return 'skip_fast';
  return null;
}

/** Counts actual forward playback, excluding seeks, pauses and hidden tabs. */
export class PlaybackProgress {
  private previousTime: number | null = null;
  private previousWall: number | null = null;
  private watched = 0;
  private reported = false;
  sample(time: number, duration: number, now: number, playing: boolean): number | null {
    if (this.previousTime !== null && this.previousWall !== null && playing) {
      const delta = time - this.previousTime;
      const elapsed = (now - this.previousWall) / 1000;
      if (delta > 0 && elapsed > 0 && elapsed <= 2 && delta <= elapsed * 1.25 + 0.1) this.watched += delta;
    }
    this.previousTime = playing ? time : null;
    this.previousWall = playing ? now : null;
    if (!this.reported && Number.isFinite(duration) && duration > 0 && this.watched >= duration * 0.9) {
      this.reported = true;
      return Math.round(this.watched * 1000);
    }
    return null;
  }
}
