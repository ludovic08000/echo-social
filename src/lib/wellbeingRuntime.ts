export interface DetoxSchedule {
  enabled: boolean;
  days: string[];
  startHour: number;
  endHour: number;
  streakDays?: number;
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function isDetoxScheduleActive(schedule: DetoxSchedule | null | undefined, now = new Date()) {
  if (!schedule?.enabled || !Array.isArray(schedule.days)) return false;
  const hour = now.getHours();
  const start = Math.min(23, Math.max(0, Number(schedule.startHour) || 0));
  const end = Math.min(23, Math.max(0, Number(schedule.endHour) || 0));
  const currentDay = DAY_KEYS[now.getDay()];

  if (start > end) {
    // Overnight windows belong to the day on which they start. For example,
    // a Monday 22:00–07:00 detox must still be active Tuesday at 01:00.
    const previousDay = DAY_KEYS[(now.getDay() + 6) % 7];
    return (hour >= start && schedule.days.includes(currentDay))
      || (hour < end && schedule.days.includes(previousDay));
  }

  return schedule.days.includes(currentDay) && hour >= start && hour < end;
}

export function isBedtimeHour(targetHour: number, now = new Date()) {
  return now.getHours() === ((Number(targetHour) % 24) + 24) % 24;
}
