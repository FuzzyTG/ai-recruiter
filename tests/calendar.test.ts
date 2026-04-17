import { describe, it, expect } from 'vitest';
import {
  parseCalendarString,
  findFreeSlots,
  generateIcs,
  verifyDateWeekday,
  type BusySlot,
  type FreeSlot,
  type WorkingHours,
} from '../src/calendar.js';
import { validateIcs } from '../src/validators.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal valid ICS string with events
// ---------------------------------------------------------------------------

function makeIcsString(events: Array<{ start: string; end: string; summary: string; allDay?: boolean }>): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//Test//EN',
    'CALSCALE:GREGORIAN',
  ];

  for (const evt of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${crypto.randomUUID()}@test`);

    if (evt.allDay) {
      // All-day event: VALUE=DATE format (YYYYMMDD, no time component)
      lines.push(`DTSTART;VALUE=DATE:${evt.start}`);
      lines.push(`DTEND;VALUE=DATE:${evt.end}`);
    } else {
      lines.push(`DTSTART:${evt.start}`);
      lines.push(`DTEND:${evt.end}`);
    }

    lines.push(`SUMMARY:${evt.summary}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// parseCalendarString (sync version for testing without network)
// ---------------------------------------------------------------------------

describe('parseCalendarString', () => {
  it('should parse 3 timed events into 3 BusySlots', () => {
    const ics = makeIcsString([
      { start: '20260415T090000Z', end: '20260415T100000Z', summary: 'Meeting A' },
      { start: '20260415T110000Z', end: '20260415T120000Z', summary: 'Meeting B' },
      { start: '20260415T140000Z', end: '20260415T150000Z', summary: 'Meeting C' },
    ]);

    const slots = parseCalendarString(ics);

    expect(slots).toHaveLength(3);
    expect(slots[0].summary).toBe('Meeting A');
    expect(slots[1].summary).toBe('Meeting B');
    expect(slots[2].summary).toBe('Meeting C');
  });

  it('should filter out all-day events', () => {
    const ics = makeIcsString([
      { start: '20260415T090000Z', end: '20260415T100000Z', summary: 'Normal' },
      { start: '20260415', end: '20260416', summary: 'All Day', allDay: true },
    ]);

    const slots = parseCalendarString(ics);

    expect(slots).toHaveLength(1);
    expect(slots[0].summary).toBe('Normal');
  });

  it('should sort events by start time', () => {
    const ics = makeIcsString([
      { start: '20260415T140000Z', end: '20260415T150000Z', summary: 'Late' },
      { start: '20260415T080000Z', end: '20260415T090000Z', summary: 'Early' },
      { start: '20260415T110000Z', end: '20260415T120000Z', summary: 'Mid' },
    ]);

    const slots = parseCalendarString(ics);

    expect(slots).toHaveLength(3);
    expect(slots[0].summary).toBe('Early');
    expect(slots[1].summary).toBe('Mid');
    expect(slots[2].summary).toBe('Late');
  });
});

// ---------------------------------------------------------------------------
// findFreeSlots
// ---------------------------------------------------------------------------

describe('findFreeSlots', () => {
  const workingHours: WorkingHours = {
    startHour: 9,
    endHour: 17,
    days: [1, 2, 3, 4, 5], // Mon-Fri
  };

  it('should find a 2-hour free gap between 2 busy slots', () => {
    // Wednesday April 15, 2026
    const busy: BusySlot[] = [
      { start: new Date('2026-04-15T09:00:00Z'), end: new Date('2026-04-15T11:00:00Z') },
      { start: new Date('2026-04-15T13:00:00Z'), end: new Date('2026-04-15T17:00:00Z') },
    ];

    const free = findFreeSlots(busy, {
      rangeStart: new Date('2026-04-15T00:00:00Z'),
      rangeEnd: new Date('2026-04-16T00:00:00Z'),
      workingHours,
      timezone: 'UTC',
    });

    expect(free).toHaveLength(1);
    expect(free[0].start.toISOString()).toBe('2026-04-15T11:00:00.000Z');
    expect(free[0].end.toISOString()).toBe('2026-04-15T13:00:00.000Z');
  });

  it('should respect working hours', () => {
    // No busy slots, but only working hours count
    const free = findFreeSlots([], {
      rangeStart: new Date('2026-04-15T00:00:00Z'),
      rangeEnd: new Date('2026-04-16T00:00:00Z'),
      workingHours,
      timezone: 'UTC',
    });

    expect(free).toHaveLength(1); // One big free block 9-17
    expect(free[0].start.toISOString()).toBe('2026-04-15T09:00:00.000Z');
    expect(free[0].end.toISOString()).toBe('2026-04-15T17:00:00.000Z');
  });

  it('should exclude weekend days', () => {
    // April 18, 2026 is Saturday; April 19 is Sunday
    const free = findFreeSlots([], {
      rangeStart: new Date('2026-04-18T00:00:00Z'),
      rangeEnd: new Date('2026-04-20T00:00:00Z'),
      workingHours,
      timezone: 'UTC',
    });

    expect(free).toHaveLength(0);
  });

  it('should respect excludeSlots', () => {
    const free = findFreeSlots([], {
      rangeStart: new Date('2026-04-15T00:00:00Z'),
      rangeEnd: new Date('2026-04-16T00:00:00Z'),
      workingHours,
      timezone: 'UTC',
      excludeSlots: [
        { start: new Date('2026-04-15T09:00:00Z'), end: new Date('2026-04-15T17:00:00Z') },
      ],
    });

    expect(free).toHaveLength(0);
  });

  it('should return no free slots on a fully packed calendar', () => {
    const busy: BusySlot[] = [
      { start: new Date('2026-04-15T09:00:00Z'), end: new Date('2026-04-15T17:00:00Z') },
    ];

    const free = findFreeSlots(busy, {
      rangeStart: new Date('2026-04-15T00:00:00Z'),
      rangeEnd: new Date('2026-04-16T00:00:00Z'),
      workingHours,
      timezone: 'UTC',
    });

    expect(free).toHaveLength(0);
  });

  it('should handle a multi-day range', () => {
    // Wed Apr 15 + Thu Apr 16, both empty
    const free = findFreeSlots([], {
      rangeStart: new Date('2026-04-15T00:00:00Z'),
      rangeEnd: new Date('2026-04-17T00:00:00Z'),
      workingHours,
      timezone: 'UTC',
    });

    expect(free).toHaveLength(2); // one block per day
    expect(free[0].start.toISOString()).toBe('2026-04-15T09:00:00.000Z');
    expect(free[1].start.toISOString()).toBe('2026-04-16T09:00:00.000Z');
  });

  it('should filter by minimum duration (30-min gap, 60-min required)', () => {
    const busy: BusySlot[] = [
      { start: new Date('2026-04-15T09:00:00Z'), end: new Date('2026-04-15T10:30:00Z') },
      { start: new Date('2026-04-15T11:00:00Z'), end: new Date('2026-04-15T17:00:00Z') },
    ];

    const free = findFreeSlots(busy, {
      rangeStart: new Date('2026-04-15T00:00:00Z'),
      rangeEnd: new Date('2026-04-16T00:00:00Z'),
      workingHours,
      timezone: 'UTC',
      minDurationMinutes: 60, // require 60 min, gap is only 30 min
    });

    expect(free).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateIcs
// ---------------------------------------------------------------------------

describe('generateIcs', () => {
  const baseOpts = {
    start: new Date('2026-04-15T14:00:00Z'),
    end: new Date('2026-04-15T15:00:00Z'),
    summary: 'Interview: Alice',
    description: 'Technical interview for Senior PM role',
    location: 'https://meet.example.com/interview-alice',
    organizerEmail: 'recruiter@example.com',
    organizerName: 'Recruiter',
    attendeeEmail: 'alice@example.com',
    attendeeName: 'Alice',
  };

  it('should contain all required ICS fields', () => {
    const ics = generateIcs(baseOpts);

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID:');
    expect(ics).toContain('DTSTART:');
    expect(ics).toContain('DTEND:');
    expect(ics).toContain('UID:');
    expect(ics).toContain('DTSTAMP:');
    expect(ics).toContain('SUMMARY:');

    // Validate the ICS with the real validator
    const errors = validateIcs(ics);
    expect(errors).toHaveLength(0);
  });

  it('should have DTSTART before DTEND', () => {
    const ics = generateIcs(baseOpts);

    const dtstart = ics.match(/DTSTART:(\S+)/)?.[1];
    const dtend = ics.match(/DTEND:(\S+)/)?.[1];

    expect(dtstart).toBeDefined();
    expect(dtend).toBeDefined();
    expect(dtstart! < dtend!).toBe(true);
  });

  it('should produce UID with @ai-recruiter suffix', () => {
    const ics = generateIcs(baseOpts);
    const uid = ics.match(/UID:(.+)/)?.[1]?.trim();
    expect(uid).toMatch(/@ai-recruiter$/);
  });

  it('should include METHOD:PUBLISH', () => {
    const ics = generateIcs(baseOpts);
    expect(ics).toContain('METHOD:PUBLISH');
  });

  it('should contain attendee and organizer emails', () => {
    const ics = generateIcs(baseOpts);
    // Unfold RFC 5545 continuation lines (CRLF + space) before checking
    const unfolded = ics.replace(/\r\n[ \t]/g, '');
    expect(unfolded).toContain('mailto:recruiter@example.com');
    expect(unfolded).toContain('mailto:alice@example.com');
    expect(unfolded).toContain('ORGANIZER');
    expect(unfolded).toContain('ATTENDEE');
  });

  it('should use UTC dates (Z suffix)', () => {
    const ics = generateIcs(baseOpts);
    const dtstart = ics.match(/DTSTART:(\S+)/)?.[1];
    const dtend = ics.match(/DTEND:(\S+)/)?.[1];

    expect(dtstart).toMatch(/Z$/);
    expect(dtend).toMatch(/Z$/);
  });

  it('should throw when DTSTART >= DTEND', () => {
    expect(() =>
      generateIcs({
        ...baseOpts,
        start: new Date('2026-04-15T15:00:00Z'),
        end: new Date('2026-04-15T14:00:00Z'),
      }),
    ).toThrow('DTSTART must be before DTEND');
  });
});

// ---------------------------------------------------------------------------
// verifyDateWeekday
// ---------------------------------------------------------------------------

describe('verifyDateWeekday', () => {
  // April 15, 2026 is a Wednesday
  const wed = new Date('2026-04-15T12:00:00Z');

  it('should match zh "周三" for Wednesday', () => {
    expect(verifyDateWeekday(wed, '周三', 'zh')).toBe(true);
  });

  it('should NOT match zh "周四" for Wednesday', () => {
    expect(verifyDateWeekday(wed, '周四', 'zh')).toBe(false);
  });

  it('should match en "Wednesday" for Wednesday', () => {
    expect(verifyDateWeekday(wed, 'Wednesday', 'en')).toBe(true);
  });

  it('should NOT match en "Thursday" for Wednesday', () => {
    expect(verifyDateWeekday(wed, 'Thursday', 'en')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateCancelIcs
// ---------------------------------------------------------------------------

import { generateCancelIcs } from '../src/calendar.js';

describe('generateCancelIcs', () => {
  const baseOptions = {
    uid: 'test-uid-123@ai-recruiter',
    start: new Date('2026-04-20T10:00:00Z'),
    end: new Date('2026-04-20T11:00:00Z'),
    summary: 'Interview: Test - Engineer',
    organizerEmail: 'hm@test.com',
    organizerName: 'Test HM',
    attendeeEmail: 'candidate@test.com',
    attendeeName: 'Test Candidate',
  };

  it('produces valid ICS with METHOD:CANCEL', () => {
    const ics = generateCancelIcs(baseOptions);
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:1');
    expect(ics).toContain('test-uid-123@ai-recruiter');
    const errors = validateIcs(ics);
    expect(errors).toEqual([]);
  });

  it('uses provided UID', () => {
    const ics = generateCancelIcs(baseOptions);
    expect(ics).toContain('UID:test-uid-123@ai-recruiter');
  });

  it('includes organizer and attendee', () => {
    const ics = generateCancelIcs(baseOptions);
    expect(ics).toContain('ORGANIZER');
    expect(ics).toContain('mailto:hm@test.com');
    expect(ics).toContain('ATTENDEE');
    expect(ics).toContain('mailto:candidate@test.com');
  });
});
