import { describe, it, expect } from 'vitest';
import { SIGNAL_LABEL, trainingSnippet, clickThroughRate, normalizeAffinities } from '../../../supabase/functions/_shared/feed-training-policy';
import { trainFeedCandidate } from '../../../supabase/functions/_shared/feed-two-tower';
describe('offline training policies',()=>{
  it('handles new signals and negative-only histories',()=>{
    for(const key of ['watch_complete','save','not_interested','dwell_medium']) expect(SIGNAL_LABEL[key]).not.toBeUndefined();
    expect(normalizeAffinities({a:-10,b:-5})).toEqual({a:-1,b:-.5});
  });
  it('minimizes identifiable patterns and bounds text',()=>{
    const text=trainingSnippet('Contact nom@example.fr +33 6 12 34 56 78 https://host/?token=SECRET @alice '+'x'.repeat(1000));
    expect(text).not.toMatch(/example|SECRET|alice|12 34/);
    expect(text.length).toBeLessThanOrEqual(200);
  });
  it('measures CTR using unique viewed pairs, not all positive events',()=>{
    const e=(signal_type:string)=>({user_id:'u',post_id:'p',signal_type});
    expect(clickThroughRate([e('view'),e('like'),e('save')])).toBe(0);
    expect(clickThroughRate([e('view'),e('view'),e('click'),e('click')])).toBe(1);
  });
  it('is deterministic, finite and refuses promotion without enough holdout evidence',()=>{
    const events=Array.from({length:30},(_,i)=>({user_id:'u'+i%3,post_id:'p'+i,signal_type:'save',created_at:new Date(i*1000).toISOString()}));
    const a=trainFeedCandidate(events),b=trainFeedCandidate(events);
    expect(a).toEqual(b);
    expect(a.metrics.offline_gate).toBe(false);
    expect(a.metrics.production_order_changed).toBe(false);
    for(const v of a.artifacts.users) {
      expect(v.embedding).toHaveLength(256);
      expect(Math.hypot(...v.embedding)).toBeCloseTo(1,6);
    }
  });
});
