import nodeIcal from 'node-ical';
import type { CalendarResponse, VEvent } from 'node-ical';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BusySlot {
  start: Date;
  end: Date;
  summary?: string;
}

export interface FreeSlot {
  start: Date;
  end: Date;
}

export interface WorkingHours {
  startHour: number; // 0-23
  endHour: number;   // 0-23
  days: number[];    // 0=Sun … 6=Sat
}

export interface FindFreeSlotsOptions {
  rangeStart: Date;
  rangeEnd: Date;
  workingHours: WorkingHours;
  timezone?: string;          // IANA tz, defaults to 'UTC'
  minDurationMinutes?: number; // minimum slot duration, defaults to 30
  excludeSlots?: FreeSlot[];   // already-offered slots to skip
}

export interface GenerateIcsOptions {
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location: string;
  organizerEmail: string;
  organizerName?: string;
  attendeeEmail: string;
  attendeeName?: string;
  uid?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CalendarFetchError extends Error {
  public readonly url: string;

  constructor(url: string, cause: Error) {
    super(`Failed to fetch calendar from ${url}: ${cause.message}`);
    this.name = 'CalendarFetchError';
    this.url = url;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format Date to ICS UTC datetime: 20260415T140000Z */
function toIcsUtc(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * RFC 5545 line folding: lines longer than 75 octets are split with CRLF
 * followed by a single space (continuation).
 */
function foldLine(line: string): string {
  // Byte-level folding (UTF-8 aware)
  const buf = Buffer.from(line, 'utf-8');
  if (buf.length <= 75) return line;

  const parts: string[] = [];
  let offset = 0;
  let first = true;

  while (offset < buf.length) {
    // First line: up to 75 octets.  Continuation lines: 74 (75 minus the leading space).
    const maxChunk = first ? 75 : 74;
    let end = Math.min(offset + maxChunk, buf.length);

    // Avoid splitting inside a multi-byte UTF-8 sequence.
    // A continuation byte starts with 10xxxxxx (0x80-0xBF).
    while (end < buf.length && end > offset + 1 && (buf[end] & 0xc0) === 0x80) {
      end--;
    }

    const slice = buf.subarray(offset, end).toString('utf-8');
    if (first) {
      parts.push(slice);
      first = false;
    } else {
      parts.push(' ' + slice);
    }
    offset = end;
  }

  return parts.join('\r\n');
}

/** Build a folded ICS line and CRLF-terminate it. */
function icsLine(content: string): string {
  return foldLine(content) + '\r\n';
}

/**
 * Get day-of-week for a date in a given timezone.
 * Returns 0=Sun … 6=Sat
 */
function getDayInTz(d: Date, tz: string): number {
  const str = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[str] ?? d.getDay();
}

/**
 * Get the hour (0-23) of a Date in a given timezone.
 */
function getHourInTz(d: Date, tz: string): number {
  return parseInt(d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
}

/**
 * Build a Date representing a specific hour on a specific date in a timezone.
 * We iterate to find the UTC offset for that local time.
 */
function dateAtHourInTz(base: Date, hour: number, tz: string): Date {
  // Start from a rough UTC guess
  const year = parseInt(
    base.toLocaleString('en-US', { timeZone: tz, year: 'numeric' }),
    10,
  );
  const month =
    parseInt(base.toLocaleString('en-US', { timeZone: tz, month: 'numeric' }), 10) - 1;
  const day = parseInt(
    base.toLocaleString('en-US', { timeZone: tz, day: 'numeric' }),
    10,
  );

  // Create a date in UTC at the desired local values
  const guess = new Date(Date.UTC(year, month, day, hour, 0, 0, 0));

  // Adjust: determine the offset of our guess in the target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(guess);
  const getValue = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);
  const localHour = getValue('hour') === 24 ? 0 : getValue('hour');
  const diff = localHour - hour;
  guess.setUTCHours(guess.getUTCHours() - diff);

  return guess;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Fetch and parse an iCalendar feed from a URL.
 * Returns busy slots extracted from VEVENT components (all-day events excluded).
 */
export async function parseCalendarFeed(url: string): Promise<BusySlot[]> {
  let data: CalendarResponse;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    data = nodeIcal.parseICS(text) as CalendarResponse;
  } catch (err) {
    throw new CalendarFetchError(url, err instanceof Error ? err : new Error(String(err)));
  }

  const slots: BusySlot[] = [];

  for (const key of Object.keys(data)) {
    const component = data[key];
    if (!component || component.type !== 'VEVENT') continue;

    const event = component as VEvent;
    const start = event.start ? new Date(event.start as unknown as string | number | Date) : null;
    const end = event.end ? new Date(event.end as unknown as string | number | Date) : null;

    if (!start || !end) continue;

    // Filter all-day events: typically start at 00:00 and span >= 24 h with
    // datetype === 'date' (node-ical specific).
    if ((event as any).datetype === 'date') continue;

    const rawSummary = event.summary;
    const summary = typeof rawSummary === 'string'
      ? rawSummary
      : (rawSummary as any)?.val ?? undefined;

    slots.push({ start, end, summary });
  }

  // Sort chronologically
  slots.sort((a, b) => a.start.getTime() - b.start.getTime());

  return slots;
}

/**
 * Parse an ICS string directly (useful for testing without network).
 */
export function parseCalendarString(icsString: string): BusySlot[] {
  const data = nodeIcal.parseICS(icsString) as CalendarResponse;
  const slots: BusySlot[] = [];

  for (const key of Object.keys(data)) {
    const component = data[key];
    if (!component || component.type !== 'VEVENT') continue;

    const event = component as VEvent;
    const start = event.start ? new Date(event.start as unknown as string | number | Date) : null;
    const end = event.end ? new Date(event.end as unknown as string | number | Date) : null;

    if (!start || !end) continue;

    if ((event as any).datetype === 'date') continue;

    const rawSummary = event.summary;
    const summary = typeof rawSummary === 'string'
      ? rawSummary
      : (rawSummary as any)?.val ?? undefined;

    slots.push({ start, end, summary });
  }

  slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  return slots;
}

/**
 * Find free slots within a date range given a list of busy slots.
 */
export function findFreeSlots(
  busySlots: BusySlot[],
  options: FindFreeSlotsOptions,
): FreeSlot[] {
  const {
    rangeStart,
    rangeEnd,
    workingHours,
    timezone = 'UTC',
    minDurationMinutes = 30,
    excludeSlots = [],
  } = options;

  const minDurationMs = minDurationMinutes * 60_000;

  // Collect each working day in the range.
  // We enumerate calendar days in the target timezone to avoid local-tz bugs.
  const freeSlots: FreeSlot[] = [];
  const processedDays = new Set<string>();

  // Use UTC-based cursor to avoid local-timezone setHours issues
  const cursor = new Date(Date.UTC(
    rangeStart.getUTCFullYear(),
    rangeStart.getUTCMonth(),
    rangeStart.getUTCDate(),
  ));

  // Iterate day by day (UTC midnight steps, but we check timezone-local day)
  while (cursor < rangeEnd) {
    const dayOfWeek = getDayInTz(cursor, timezone);

    // Build a dedup key using the local date in the target timezone
    const localDateStr = cursor.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD
    if (!processedDays.has(localDateStr) && workingHours.days.includes(dayOfWeek)) {
      processedDays.add(localDateStr);

      const dayStart = dateAtHourInTz(cursor, workingHours.startHour, timezone);
      const dayEnd = dateAtHourInTz(cursor, workingHours.endHour, timezone);

      // Clamp to overall range
      const windowStart = dayStart < rangeStart ? rangeStart : dayStart;
      const windowEnd = dayEnd > rangeEnd ? rangeEnd : dayEnd;

      if (windowStart < windowEnd) {
        // Get busy slots that overlap this window
        const dayBusy = busySlots
          .filter((b) => b.end > windowStart && b.start < windowEnd)
          .map((b) => ({
            start: b.start < windowStart ? windowStart : b.start,
            end: b.end > windowEnd ? windowEnd : b.end,
          }))
          .sort((a, b) => a.start.getTime() - b.start.getTime());

        // Walk through the window and find gaps
        let pointer = new Date(windowStart);
        for (const busy of dayBusy) {
          if (pointer < busy.start) {
            const gap: FreeSlot = { start: new Date(pointer), end: new Date(busy.start) };
            if (gap.end.getTime() - gap.start.getTime() >= minDurationMs) {
              freeSlots.push(gap);
            }
          }
          if (busy.end > pointer) {
            pointer = new Date(busy.end);
          }
        }
        // Trailing gap
        if (pointer < windowEnd) {
          const gap: FreeSlot = { start: new Date(pointer), end: new Date(windowEnd) };
          if (gap.end.getTime() - gap.start.getTime() >= minDurationMs) {
            freeSlots.push(gap);
          }
        }
      }
    } else if (!processedDays.has(localDateStr)) {
      processedDays.add(localDateStr);
    }

    // Advance cursor by 24 hours (UTC-safe)
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Remove excluded slots (overlap-based removal)
  const result = freeSlots.filter((free) => {
    return !excludeSlots.some(
      (ex) => ex.start < free.end && ex.end > free.start,
    );
  });

  return result;
}

/**
 * Generate an ICS string (RFC 5545 / 5546 compliant) for a calendar invite.
 */
export function generateIcs(options: GenerateIcsOptions): string {
  const {
    start,
    end,
    summary,
    description,
    location,
    organizerEmail,
    organizerName,
    attendeeEmail,
    attendeeName,
    uid = `${crypto.randomUUID()}@ai-recruiter`,
  } = options;

  if (start >= end) {
    throw new Error('DTSTART must be before DTEND');
  }

  const lines: string[] = [];

  lines.push(icsLine('BEGIN:VCALENDAR'));
  lines.push(icsLine('VERSION:2.0'));
  lines.push(icsLine('PRODID:-//AI Recruiter//AI Recruiter//EN'));
  lines.push(icsLine('CALSCALE:GREGORIAN'));
  lines.push(icsLine('METHOD:PUBLISH'));
  lines.push(icsLine('BEGIN:VEVENT'));
  lines.push(icsLine(`UID:${uid}`));
  lines.push(icsLine(`DTSTAMP:${toIcsUtc(new Date())}`));
  lines.push(icsLine(`DTSTART:${toIcsUtc(start)}`));
  lines.push(icsLine(`DTEND:${toIcsUtc(end)}`));
  lines.push(icsLine(`SUMMARY:${summary}`));
  lines.push(icsLine(`DESCRIPTION:${description}`));
  lines.push(icsLine(`LOCATION:${location}`));

  const orgCn = organizerName ? `;CN=${organizerName}` : '';
  lines.push(icsLine(`ORGANIZER${orgCn}:mailto:${organizerEmail}`));

  const attCn = attendeeName ? `;CN=${attendeeName}` : '';
  lines.push(
    icsLine(
      `ATTENDEE;RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION${attCn}:mailto:${attendeeEmail}`,
    ),
  );

  lines.push(icsLine('STATUS:CONFIRMED'));
  lines.push(icsLine('END:VEVENT'));
  lines.push(icsLine('END:VCALENDAR'));

  return lines.join('');
}

/**
 * Verify that a date falls on the expected weekday.
 * Supports Chinese (zh) weekday names (e.g. "周一"–"周日") and
 * English weekday names (e.g. "Monday"–"Sunday").
 */
export function verifyDateWeekday(
  date: Date,
  expectedWeekday: string,
  language: 'zh' | 'en' = 'en',
): boolean {
  const dayIndex = date.getDay(); // 0=Sun, 1=Mon, ... 6=Sat

  if (language === 'zh') {
    const zhDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return zhDays[dayIndex] === expectedWeekday;
  }

  // English
  const enDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return enDays[dayIndex].toLowerCase() === expectedWeekday.toLowerCase();
}

// ---------------------------------------------------------------------------
// Cancel ICS generation
// ---------------------------------------------------------------------------

export interface GenerateCancelIcsOptions {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  organizerEmail: string;
  organizerName?: string;
  attendeeEmail: string;
  attendeeName?: string;
}

export function generateCancelIcs(options: GenerateCancelIcsOptions): string {
  const {
    uid,
    start,
    end,
    summary,
    organizerEmail,
    organizerName,
    attendeeEmail,
    attendeeName,
  } = options;

  const lines: string[] = [];

  lines.push(icsLine('BEGIN:VCALENDAR'));
  lines.push(icsLine('VERSION:2.0'));
  lines.push(icsLine('PRODID:-//AI Recruiter//AI Recruiter//EN'));
  lines.push(icsLine('CALSCALE:GREGORIAN'));
  lines.push(icsLine('METHOD:CANCEL'));
  lines.push(icsLine('BEGIN:VEVENT'));
  lines.push(icsLine(`UID:${uid}`));
  lines.push(icsLine(`DTSTAMP:${toIcsUtc(new Date())}`));
  lines.push(icsLine(`DTSTART:${toIcsUtc(start)}`));
  lines.push(icsLine(`DTEND:${toIcsUtc(end)}`));
  lines.push(icsLine(`SUMMARY:${summary}`));
  lines.push(icsLine(`SEQUENCE:1`));

  const orgCn = organizerName ? `;CN=${organizerName}` : '';
  lines.push(icsLine(`ORGANIZER${orgCn}:mailto:${organizerEmail}`));

  const attCn = attendeeName ? `;CN=${attendeeName}` : '';
  lines.push(
    icsLine(
      `ATTENDEE;RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION${attCn}:mailto:${attendeeEmail}`,
    ),
  );

  lines.push(icsLine('STATUS:CANCELLED'));
  lines.push(icsLine('END:VEVENT'));
  lines.push(icsLine('END:VCALENDAR'));

  return lines.join('');
}
