import { describe, expect, it } from 'vitest';
import { buildEditorialBlendPlan, editorialMediaSlotAfterPost } from '@/lib/editorialFeed';

describe('editorial feed blending', () => {
  it('lets the user disable editorial cards explicitly', () => {
    const plan = buildEditorialBlendPlan(0);
    expect(plan.enabled).toBe(false);
    expect(editorialMediaSlotAfterPost(20, plan)).toBeNull();
  });

  it('increases media cadence without replacing the social feed', () => {
    const light = buildEditorialBlendPlan(20);
    const balanced = buildEditorialBlendPlan(30);
    const strong = buildEditorialBlendPlan(100);

    expect(light.cadence).toBeGreaterThan(balanced.cadence);
    expect(balanced.cadence).toBeGreaterThan(strong.cadence);
    expect(strong.cadence).toBeGreaterThan(1);
    expect(strong.maxItems).toBeGreaterThan(balanced.maxItems);
  });

  it('assigns stable, deduplicated slots after social posts', () => {
    const plan = buildEditorialBlendPlan(30);
    const slots = Array.from({ length: 24 }, (_, index) => editorialMediaSlotAfterPost(index, plan))
      .filter((slot): slot is number => slot !== null);

    expect(slots).toEqual([0, 1, 2, 3]);
    expect(new Set(slots).size).toBe(slots.length);
  });
});
