import {
  type Candidate,
  CandidateState,
  type DimensionScore,
  type Framework,
  isApprovalRequired,
} from './models.js';

// ---------------------------------------------------------------------------
// 1. validateDateWeekday
// ---------------------------------------------------------------------------

const ZH_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function validateDateWeekday(
  dateStr: string,
  weekdayStr: string,
  language: 'zh' | 'en',
): { valid: boolean; expected: string; received: string } {
  const date = new Date(dateStr);
  const dayIndex = date.getUTCDay(); // 0=Sunday

  const weekdays = language === 'zh' ? ZH_WEEKDAYS : EN_WEEKDAYS;
  const expected = weekdays[dayIndex];

  const normalise = (s: string) => s.trim().toLowerCase();
  const valid = normalise(expected) === normalise(weekdayStr);

  return { valid, expected, received: weekdayStr };
}

// ---------------------------------------------------------------------------
// 2. scanEmailForDateWeekdayErrors
// ---------------------------------------------------------------------------

function inferYear(month: number, day: number): number {
  const now = new Date();
  const currentYear = now.getFullYear();
  const candidate = new Date(Date.UTC(currentYear, month - 1, day));
  // If the date has already passed this year, assume next year
  if (candidate.getTime() < Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) {
    return currentYear + 1;
  }
  return currentYear;
}

function toIsoDate(year: number, month: number, day: number): string {
  const m = month.toString().padStart(2, '0');
  const d = day.toString().padStart(2, '0');
  return `${year}-${m}-${d}`;
}

const EN_MONTH_MAP: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function scanEmailForDateWeekdayErrors(
  emailBody: string,
  language: 'zh' | 'en',
): Array<{
  dateStr: string;
  claimedWeekday: string;
  correctWeekday: string;
  position: number;
}> {
  const errors: Array<{
    dateStr: string;
    claimedWeekday: string;
    correctWeekday: string;
    position: number;
  }> = [];

  if (language === 'zh') {
    // Match patterns like "4月15日（周三）" or "4月15日(周三)"
    // Parentheses can be fullwidth （） or halfwidth ()
    const zhPattern = /(\d{1,2})月(\d{1,2})日[（(](周[一二三四五六日])[）)]/g;
    let match: RegExpExecArray | null;
    while ((match = zhPattern.exec(emailBody)) !== null) {
      const month = parseInt(match[1], 10);
      const day = parseInt(match[2], 10);
      const claimedWeekday = match[3];
      const year = inferYear(month, day);
      const dateStr = toIsoDate(year, month, day);
      const result = validateDateWeekday(dateStr, claimedWeekday, 'zh');
      if (!result.valid) {
        errors.push({
          dateStr,
          claimedWeekday,
          correctWeekday: result.expected,
          position: match.index,
        });
      }
    }
  } else {
    // English: "April 15 (Wednesday)"
    const enMonthNames = Object.keys(EN_MONTH_MAP).map(
      (m) => m.charAt(0).toUpperCase() + m.slice(1),
    );
    const monthPattern = enMonthNames.join('|');
    const enPattern = new RegExp(
      `(${monthPattern})\\s+(\\d{1,2})\\s*[（(]([A-Za-z]+)[）)]`,
      'g',
    );
    let match: RegExpExecArray | null;
    while ((match = enPattern.exec(emailBody)) !== null) {
      const monthName = match[1].toLowerCase();
      const month = EN_MONTH_MAP[monthName];
      const day = parseInt(match[2], 10);
      const claimedWeekday = match[3];
      const year = inferYear(month, day);
      const dateStr = toIsoDate(year, month, day);
      const result = validateDateWeekday(dateStr, claimedWeekday, 'en');
      if (!result.valid) {
        errors.push({
          dateStr,
          claimedWeekday,
          correctWeekday: result.expected,
          position: match.index,
        });
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 3. validateApproval
// ---------------------------------------------------------------------------

export function validateApproval(
  candidate: Candidate,
  targetState: CandidateState,
  approved: boolean,
): { valid: boolean; reason?: string } {
  const requiresApproval = isApprovalRequired(candidate.state, targetState);
  if (requiresApproval && !approved) {
    return { valid: false, reason: `Approval required for transition to ${targetState}` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// 4. validateIcs
// ---------------------------------------------------------------------------

export function validateIcs(icsContent: string): string[] {
  const errors: string[] = [];

  if (!icsContent.includes('BEGIN:VCALENDAR')) {
    errors.push('Missing BEGIN:VCALENDAR');
  }
  if (!icsContent.includes('VERSION:2.0')) {
    errors.push('Missing VERSION:2.0');
  }
  const hasValidMethod = icsContent.includes('METHOD:PUBLISH') || icsContent.includes('METHOD:CANCEL');
  if (!hasValidMethod) {
    errors.push('Missing METHOD (must be PUBLISH or CANCEL)');
  }

  const hasVeventStart = icsContent.includes('BEGIN:VEVENT');
  const hasVeventEnd = icsContent.includes('END:VEVENT');
  if (!hasVeventStart || !hasVeventEnd) {
    errors.push('Missing VEVENT block');
  }

  if (!icsContent.includes('END:VCALENDAR')) {
    errors.push('Missing END:VCALENDAR');
  }

  // Check VEVENT required fields
  if (hasVeventStart && hasVeventEnd) {
    const veventMatch = icsContent.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/);
    if (veventMatch) {
      const veventBody = veventMatch[1];
      if (!veventBody.includes('DTSTART')) {
        errors.push('Missing DTSTART in VEVENT');
      }
      if (!veventBody.includes('DTEND')) {
        errors.push('Missing DTEND in VEVENT');
      }
      if (!veventBody.includes('SUMMARY')) {
        errors.push('Missing SUMMARY in VEVENT');
      }

      // UID check
      const uidMatch = veventBody.match(/UID:(.+)/);
      if (!uidMatch) {
        errors.push('Missing UID in VEVENT');
      } else if (uidMatch[1].trim() === '') {
        errors.push('UID is empty');
      }

      // DTSTART < DTEND check
      const dtstartMatch = veventBody.match(/DTSTART[^:]*:(\S+)/);
      const dtendMatch = veventBody.match(/DTEND[^:]*:(\S+)/);
      if (dtstartMatch && dtendMatch) {
        const dtstart = parseIcsDatetime(dtstartMatch[1]);
        const dtend = parseIcsDatetime(dtendMatch[1]);
        if (dtstart && dtend && dtstart >= dtend) {
          errors.push('DTSTART must be before DTEND');
        }
      }
    }
  }

  return errors;
}

function parseIcsDatetime(value: string): Date | null {
  // Handles formats like 20260415T140000Z or 20260415T140000
  const cleaned = value.trim();
  const match = cleaned.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(Date.UTC(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    parseInt(h, 10),
    parseInt(mi, 10),
    parseInt(s, 10),
  ));
}

// ---------------------------------------------------------------------------
// 5. validateThreadIntegrity
// ---------------------------------------------------------------------------

export function validateThreadIntegrity(
  conversationId: string,
  candidateConversationId: string,
): { valid: boolean; reason?: string } {
  if (conversationId !== candidateConversationId) {
    return {
      valid: false,
      reason: `Thread mismatch: expected ${candidateConversationId}, got ${conversationId}`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// 6. validateScores
// ---------------------------------------------------------------------------

export function validateScores(
  scores: Record<string, DimensionScore>,
  framework: Framework,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const dimensionNames = new Set(framework.dimensions.map((d) => d.name));
  const scoreNames = new Set(Object.keys(scores));

  // Check for missing dimensions
  for (const dim of framework.dimensions) {
    if (!scoreNames.has(dim.name)) {
      errors.push(`Missing score for dimension: ${dim.name}`);
    }
  }

  // Check for extra dimensions
  for (const name of Array.from(scoreNames)) {
    if (!dimensionNames.has(name)) {
      errors.push(`Extra dimension not in framework: ${name}`);
    }
  }

  // Validate each score
  for (const [name, ds] of Object.entries(scores)) {
    if (!Number.isInteger(ds.score) || ds.score < 1 || ds.score > 5) {
      errors.push(`Score for ${name} must be an integer 1-5, got ${ds.score}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 7. computeWeightedAverage
// ---------------------------------------------------------------------------

export function computeWeightedAverage(
  scores: Record<string, DimensionScore>,
  framework: Framework,
): number {
  let weightedSum = 0;
  for (const dim of framework.dimensions) {
    const ds = scores[dim.name];
    if (ds) {
      weightedSum += ds.score * dim.weight;
    }
  }
  // Normalise to 0-1 by dividing by max score (5)
  const normalised = weightedSum / 5;
  return Math.round(normalised * 100) / 100;
}

// ---------------------------------------------------------------------------
// 8. scanEmailForPlaceholders
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERN = /\[(?:SLOTS?|CANDIDATE[_ ]?NAME|DATE|TIME|MEETING[_ ]?LINK|SIGNATURE|COMPANY|ROLE|EMAIL|SUBJECT|BODY|INSERT|TODO|PLACEHOLDER|FILL|TBD)\]/i;

export function scanEmailForPlaceholders(emailBody: string): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  const global = new RegExp(PLACEHOLDER_PATTERN.source, 'gi');
  while ((match = global.exec(emailBody)) !== null) {
    found.push(match[0]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 9. PreflightCheck, runPreflight, runPostflight
// ---------------------------------------------------------------------------

export interface PreflightCheck {
  rule: string;
  passed: boolean;
  message?: string;
}

export function runPreflight(
  toolName: string,
  context: Record<string, unknown>,
): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  switch (toolName) {
    case 'recruit_score': {
      // Validate scores against framework
      const scores = context.scores as Record<string, DimensionScore> | undefined;
      const framework = context.framework as Framework | undefined;
      if (scores && framework) {
        const result = validateScores(scores, framework);
        checks.push({
          rule: 'scores_valid',
          passed: result.valid,
          message: result.valid ? undefined : result.errors.join('; '),
        });
      } else {
        checks.push({
          rule: 'scores_valid',
          passed: false,
          message: 'Missing scores or framework in context',
        });
      }

      // Validate framework is confirmed
      if (framework) {
        checks.push({
          rule: 'framework_confirmed',
          passed: framework.confirmed,
          message: framework.confirmed ? undefined : 'Framework is not confirmed',
        });
      } else {
        checks.push({
          rule: 'framework_confirmed',
          passed: false,
          message: 'Missing framework in context',
        });
      }
      break;
    }

    case 'recruit_schedule': {
      // Validate date-weekday in email body
      const emailBody = context.emailBody as string | undefined;
      const language = (context.language as 'zh' | 'en') ?? 'en';
      if (emailBody) {
        const dateErrors = scanEmailForDateWeekdayErrors(emailBody, language);
        checks.push({
          rule: 'date_weekday_valid',
          passed: dateErrors.length === 0,
          message: dateErrors.length === 0
            ? undefined
            : dateErrors.map((e) => `${e.dateStr}: claimed ${e.claimedWeekday}, correct ${e.correctWeekday}`).join('; '),
        });

        // Reject placeholder text in email body
        const placeholders = scanEmailForPlaceholders(emailBody);
        checks.push({
          rule: 'no_placeholders',
          passed: placeholders.length === 0,
          message: placeholders.length === 0
            ? undefined
            : `Email body contains unresolved placeholders: ${placeholders.join(', ')}`,
        });
      }

      // Validate thread integrity
      const convId = context.conversationId as string | undefined;
      const candConvId = context.candidateConversationId as string | undefined;
      if (convId !== undefined && candConvId !== undefined) {
        const threadResult = validateThreadIntegrity(convId, candConvId);
        checks.push({
          rule: 'thread_integrity',
          passed: threadResult.valid,
          message: threadResult.reason,
        });
      }
      break;
    }

    case 'recruit_decide': {
      // Validate approval
      const candidate = context.candidate as Candidate | undefined;
      const targetState = context.targetState as CandidateState | undefined;
      const approved = context.approved as boolean | undefined;
      if (candidate && targetState !== undefined && approved !== undefined) {
        const approvalResult = validateApproval(candidate, targetState, approved);
        checks.push({
          rule: 'approval_valid',
          passed: approvalResult.valid,
          message: approvalResult.reason,
        });
      }

      // Validate thread integrity
      const convId = context.conversationId as string | undefined;
      const candConvId = context.candidateConversationId as string | undefined;
      if (convId !== undefined && candConvId !== undefined) {
        const threadResult = validateThreadIntegrity(convId, candConvId);
        checks.push({
          rule: 'thread_integrity',
          passed: threadResult.valid,
          message: threadResult.reason,
        });
      }

      // Validate date-weekday in email body if present
      const emailBody = context.emailBody as string | undefined;
      const language = (context.language as 'zh' | 'en') ?? 'en';
      if (emailBody) {
        const dateErrors = scanEmailForDateWeekdayErrors(emailBody, language);
        checks.push({
          rule: 'date_weekday_valid',
          passed: dateErrors.length === 0,
          message: dateErrors.length === 0
            ? undefined
            : dateErrors.map((e) => `${e.dateStr}: claimed ${e.claimedWeekday}, correct ${e.correctWeekday}`).join('; '),
        });

        // Reject placeholder text in email body
        const placeholders = scanEmailForPlaceholders(emailBody);
        checks.push({
          rule: 'no_placeholders',
          passed: placeholders.length === 0,
          message: placeholders.length === 0
            ? undefined
            : `Email body contains unresolved placeholders: ${placeholders.join(', ')}`,
        });
      }
      break;
    }

    case 'recruit_evaluate': {
      const candidate = context.candidate as Candidate | undefined;
      if (candidate) {
        checks.push({
          rule: 'candidate_in_evaluating_state',
          passed: candidate.state === CandidateState.Evaluating,
          message: candidate.state === CandidateState.Evaluating
            ? undefined
            : `Candidate is in state ${candidate.state}, expected ${CandidateState.Evaluating}`,
        });
      } else {
        checks.push({
          rule: 'candidate_in_evaluating_state',
          passed: false,
          message: 'Missing candidate in context',
        });
      }
      break;
    }

    default:
      break;
  }

  return checks;
}

export function runPostflight(
  _toolName: string,
  context: Record<string, unknown>,
): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  const beforeState = context.beforeState as string | undefined;
  const afterState = context.afterState as string | undefined;

  checks.push({
    rule: 'state_updated',
    passed: beforeState !== afterState,
    message: beforeState === afterState
      ? `State was not updated (still ${beforeState})`
      : undefined,
  });

  return checks;
}
