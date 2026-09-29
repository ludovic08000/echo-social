import { describe, expect, it } from 'vitest';
import { isBedtimeHour, isDetoxScheduleActive, type DetoxSchedule } from '@/lib/wellbeingRuntime';

const overnightMonday: DetoxSchedule = {
  enabled: true,
  days: ['mon'],
  startHour: 22,
  endHour: 7,
};

describe('wellbeing runtime schedule', () => {
  it('activates a daytime window only on a selected day', () => {
    const schedule: DetoxSchedule = {
      enabled: true,
      days: ['mon'],
      startHour: 9,
      endHour: 17,
    };

    expect(isDetoxScheduleActive(schedule, new Date(2026, 8, 28, 12))).toBe(true);
    expect(isDetoxScheduleActive(schedule, new Date(2026, 8, 28, 18))).toBe(false);
    expect(isDetoxScheduleActive(schedule, new Date(2026, 8, 29, 12))).toBe(false);
  });

  it('keeps an overnight window active after midnight', () => {
    expect(isDetoxScheduleActive(overnightMonday, new Date(2026, 8, 28, 23))).toBe(true);
    expect(isDetoxScheduleActive(overnightMonday, new Date(2026, 8, 29, 1))).toBe(true);
    expect(isDetoxScheduleActive(overnightMonday, new Date(2026, 8, 29, 8))).toBe(false);
  });

  it('does not carry an overnight window from an unselected day', () => {
    expect(isDetoxScheduleActive(overnightMonday, new Date(2026, 8, 30, 1))).toBe(false);
  });

  it('normalizes bedtime hours', () => {
    expect(isBedtimeHour(24, new Date(2026, 8, 28, 0))).toBe(true);
    expect(isBedtimeHour(-1, new Date(2026, 8, 28, 23))).toBe(true);
  });
});
