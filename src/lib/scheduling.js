'use strict';

// Scheduling helpers
// ------------------
// Recurrence rules use a small keyword DSL (all times America/Chicago):
//   daily:HH:MM             — every day at HH:MM
//   weekdays:HH:MM          — Mon-Fri at HH:MM
//   weekly:dayname:HH:MM    — e.g., weekly:friday:16:00 (sunday..saturday)
//   monthly:N:HH:MM         — Nth day of month at HH:MM (1-31; clamped to last day)
//   every:N:weeks:HH:MM     — every N weeks from the most recent completion/seed
const SCHEDULE_TZ = 'America/Chicago';
const WEEKDAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const ISO_SCHEDULED_FOR = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i;

function parseClock(hour, minute) {
  if (!/^\d{1,2}$/.test(hour || '') || !/^\d{1,2}$/.test(minute || '')) return null;
  const hh = Number(hour);
  const mm = Number(minute);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23
    || !Number.isInteger(mm) || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function isValidScheduledFor(value) {
  if (value == null || value === '') return true;
  if (typeof value !== 'string') return false;
  const match = ISO_SCHEDULED_FOR.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0'] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;

  // Date.parse normalizes some impossible calendar dates. Check the written calendar
  // components independently before accepting the timestamp and its explicit offset.
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day) return false;
  return Number.isFinite(Date.parse(value));
}

function getTzOffsetMinutes(date, tz) {
  // Returns the offset in minutes for the given instant in the given tz.
  // Example: during CDT, returns -300 (UTC-5 means tz time is 300min behind UTC).
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map(p => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

function getDatePartsInTz(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'long',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: parts.weekday.toLowerCase()
  };
}

function tzDateToUtc(year, month, day, hour, minute, tz) {
  // Build a Date instant whose local wall-clock time in tz equals the given values.
  // We first guess a UTC moment, then correct by the tz offset at that moment.
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offsetMin = getTzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - offsetMin * 60000);
}

function daysInMonth(year, month /* 1-12 */) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function computeNextRun(rule, fromTime = new Date()) {
  if (!rule || typeof rule !== 'string') return null;
  if (!(fromTime instanceof Date) || !Number.isFinite(fromTime.getTime())) return null;
  const parts = rule.trim().toLowerCase().split(':');
  const kind = parts[0];
  const tz = SCHEDULE_TZ;
  const now = getDatePartsInTz(fromTime, tz);

  const tryBuild = (year, month, day, hh, mm) => {
    // Clamp to month length so monthly:31 in Feb falls on Feb 28/29.
    const safeDay = Math.min(day, daysInMonth(year, month));
    return tzDateToUtc(year, month, safeDay, hh, mm, tz);
  };

  if (kind === 'daily') {
    if (parts.length !== 3) return null;
    const clock = parseClock(parts[1], parts[2]);
    if (!clock) return null;
    const { hh, mm } = clock;
    let candidate = tryBuild(now.year, now.month, now.day, hh, mm);
    if (candidate.getTime() <= fromTime.getTime()) {
      // Advance by adding 24h to fromTime then reading the tz date — going through
      // Date.UTC(now.year, now.month-1, now.day+1) yields midnight UTC which is
      // still the *same calendar day* in Chicago for any tz behind UTC.
      const next = new Date(fromTime.getTime() + 24 * 60 * 60 * 1000);
      const np = getDatePartsInTz(next, tz);
      candidate = tryBuild(np.year, np.month, np.day, hh, mm);
    }
    return candidate.toISOString();
  }

  if (kind === 'weekdays') {
    if (parts.length !== 3) return null;
    const clock = parseClock(parts[1], parts[2]);
    if (!clock) return null;
    const { hh, mm } = clock;
    let cursor = new Date(fromTime);
    for (let i = 0; i < 8; i++) {
      const p = getDatePartsInTz(cursor, tz);
      const wIdx = WEEKDAY_INDEX[p.weekday];
      if (wIdx >= 1 && wIdx <= 5) {
        const candidate = tryBuild(p.year, p.month, p.day, hh, mm);
        if (candidate.getTime() > fromTime.getTime()) return candidate.toISOString();
      }
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    return null;
  }

  if (kind === 'weekly') {
    if (parts.length !== 4) return null;
    const dayName = parts[1];
    const clock = parseClock(parts[2], parts[3]);
    if (!(dayName in WEEKDAY_INDEX) || !clock) return null;
    const { hh, mm } = clock;
    const target = WEEKDAY_INDEX[dayName];
    const todayIdx = WEEKDAY_INDEX[now.weekday];
    let daysAhead = (target - todayIdx + 7) % 7;
    // Build candidate by walking forward in tz-days. Going through Date.UTC with
    // an arbitrary day offset can land on midnight UTC, which is still yesterday
    // in Chicago — produce a wrong year/month/day. Step forward via fromTime + ms.
    const stepTo = new Date(fromTime.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    let sp = getDatePartsInTz(stepTo, tz);
    let candidate = tryBuild(sp.year, sp.month, sp.day, hh, mm);
    if (candidate.getTime() <= fromTime.getTime()) {
      const nextWeek = new Date(stepTo.getTime() + 7 * 24 * 60 * 60 * 1000);
      sp = getDatePartsInTz(nextWeek, tz);
      candidate = tryBuild(sp.year, sp.month, sp.day, hh, mm);
    }
    return candidate.toISOString();
  }

  if (kind === 'monthly') {
    if (parts.length !== 4 || !/^\d{1,2}$/.test(parts[1] || '')) return null;
    const dom = Number(parts[1]);
    const clock = parseClock(parts[2], parts[3]);
    if (!Number.isInteger(dom) || dom < 1 || dom > 31 || !clock) return null;
    const { hh, mm } = clock;
    let candidate = tryBuild(now.year, now.month, dom, hh, mm);
    if (candidate.getTime() <= fromTime.getTime()) {
      const nextMonth = now.month === 12 ? 1 : now.month + 1;
      const nextYear = now.month === 12 ? now.year + 1 : now.year;
      candidate = tryBuild(nextYear, nextMonth, dom, hh, mm);
    }
    return candidate.toISOString();
  }

  if (kind === 'every') {
    const interval = Number(parts[1]); const unit = parts[2];
    const hh = Number(parts[3]); const mm = Number(parts[4]);
    if (!Number.isInteger(interval) || interval < 1 || interval > 52 || unit !== 'weeks'
      || !Number.isInteger(hh) || hh < 0 || hh > 23 || !Number.isInteger(mm) || mm < 0 || mm > 59) return null;
    const target = new Date(fromTime.getTime() + interval * 7 * 24 * 60 * 60 * 1000);
    const p = getDatePartsInTz(target, tz);
    return tryBuild(p.year, p.month, p.day, hh, mm).toISOString();
  }

  return null;
}

function isValidRecurrence(rule) {
  return rule == null || rule === '' || computeNextRun(rule) !== null;
}

function isTaskEligibleNow(task, now = new Date()) {
  if (task.status !== 'pending') return false;
  if (!task.scheduled_for) return true;
  if (!isValidScheduledFor(task.scheduled_for)
    || !(now instanceof Date) || !Number.isFinite(now.getTime())) return false;
  return new Date(task.scheduled_for).getTime() <= now.getTime();
}

module.exports = {
  SCHEDULE_TZ,
  computeNextRun,
  isValidRecurrence,
  isValidScheduledFor,
  isTaskEligibleNow,
  getDatePartsInTz,
};
