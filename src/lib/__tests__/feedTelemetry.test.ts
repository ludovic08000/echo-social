import { describe, it, expect } from 'vitest';
import { FeedEventQueue, dwellSignal, PlaybackProgress, type ServedFeedEvent } from '../feedTelemetry';
const event = (n: number): ServedFeedEvent => ({ event_id: String(n), post_id:'post', exposure_id:'served', event_type:'view' });
describe('feed telemetry', () => {
  it('never equates dwell on text to a completed video', () => {
    expect(dwellSignal(8000)).toBe('dwell_long');
    expect(dwellSignal(600)).toBe('skip_fast');
  });
  it('drains every batch and keeps IDs on retry', async () => {
    const q = new FeedEventQueue();
    for(let n=0;n<250;n++) q.push(event(n));
    await q.flush(async()=>{ throw Error('offline'); });
    expect(q.size).toBe(250);
    const received: string[]=[];
    while(q.size) await q.flush(async events=>{ expect(events.length).toBeLessThanOrEqual(100); received.push(...events.map(e=>e.event_id)); });
    expect(new Set(received).size).toBe(250);
    expect(received[0]).toBe('0');
  });
  it('does not revive the old account queue after sign-out', async () => {
    const q = new FeedEventQueue(2);
    q.push(event(1)); q.push(event(2)); q.push(event(3));
    expect(q.dropped).toBe(1);
    await q.flush(async()=>{ q.clear(); q.push(event(4)); throw Error('offline'); });
    expect(q.size).toBe(1);
    await q.flush(async events=>{ expect(events.map(e=>e.event_id)).toEqual(['4']); });
  });
  it('counts playback once, ignores seeks and background', () => {
    const progress = new PlaybackProgress();
    expect(progress.sample(0,10,0,true)).toBeNull();
    expect(progress.sample(9,10,100,true)).toBeNull();
    progress.sample(0,10,200,false);
    progress.sample(0,10,300,true);
    for(let i=1;i<9;i++) expect(progress.sample(i,10,300+i*1000,true)).toBeNull();
    expect(progress.sample(9,10,9300,true)).toBe(9000);
    expect(progress.sample(10,10,10300,true)).toBeNull();
  });
});
