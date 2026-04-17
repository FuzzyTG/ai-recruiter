import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock models.ts — the other agent is building it in parallel.
// We provide the minimal surface that validators.ts imports.
// ---------------------------------------------------------------------------

enum CandidateState {
  New = 'new',
  Screening = 'screening',
  ScreenedPass = 'screened_pass',
  ScreenedReject = 'screened_reject',
  Scheduling = 'scheduling',
  InterviewConfirmed = 'interview_confirmed',
  InterviewDone = 'interview_done',
  Evaluating = 'evaluating',
  HomeworkAssigned = 'homework_assigned',
  HomeworkSubmitted = 'homework_submitted',
  HomeworkOverdue = 'homework_overdue',
  Calibration = 'calibration',
  DecisionPending = 'decision_pending',
  Hired = 'hired',
  Rejected = 'rejected',
  Withdrawn = 'withdrawn',
  NoShow = 'no_show',
}

const { mockIsApprovalRequired } = vi.hoisted(() => {
  return { mockIsApprovalRequired: vi.fn() };
});

vi.mock('../src/models.js', () => ({
  CandidateState,
  isApprovalRequired: mockIsApprovalRequired,
}));

// Now import validators (they will get the mocked models)
import {
  validateDateWeekday,
  scanEmailForDateWeekdayErrors,
  scanEmailForPlaceholders,
  validateApproval,
  validateIcs,
  validateThreadIntegrity,
  validateScores,
  computeWeightedAverage,
  runPreflight,
  runPostflight,
} from '../src/validators.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DimensionScore { score: number; evidence: string; }
interface Dimension { name: string; weight: number; rubric: string; description: string; }
interface Framework { schema_version: number; role: string; dimensions: Dimension[]; confirmed: boolean; created_at: string; }
interface Candidate {
  schema_version: number; candidate_id: string; name: string;
  channels: { primary: 'email'; email: string; wechat?: string; telegram?: string; phone?: string };
  role: string; state: CandidateState; state_updated: string;
  pending_action: string; conversation_id: string;
  scores: { overall: number; dimensions: Record<string, DimensionScore> } | null;
  evaluations: unknown[]; offered_slots: unknown[]; timeline: unknown[];
  created_at: string;
}

const makeCandidate = (state: CandidateState): Candidate => ({
  schema_version: 1,
  candidate_id: 'C-20260414-001',
  name: 'Test',
  channels: { primary: 'email' as const, email: 'test@example.com' },
  role: 'test',
  state,
  state_updated: new Date().toISOString(),
  pending_action: '',
  conversation_id: 'conv-001',
  scores: null,
  evaluations: [],
  offered_slots: [],
  timeline: [],
  created_at: new Date().toISOString(),
});

const makeFramework = (confirmed = true): Framework => ({
  schema_version: 1,
  role: 'test',
  confirmed,
  created_at: new Date().toISOString(),
  dimensions: [
    { name: 'technical', weight: 0.6, rubric: '...', description: '...' },
    { name: 'communication', weight: 0.4, rubric: '...', description: '...' },
  ],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateDateWeekday', () => {
  // 2026-04-15 is a Wednesday
  it('returns valid for correct Chinese weekday', () => {
    const result = validateDateWeekday('2026-04-15', '周三', 'zh');
    expect(result.valid).toBe(true);
    expect(result.expected).toBe('周三');
    expect(result.received).toBe('周三');
  });

  it('returns invalid for wrong Chinese weekday', () => {
    const result = validateDateWeekday('2026-04-15', '周四', 'zh');
    expect(result.valid).toBe(false);
    expect(result.expected).toBe('周三');
    expect(result.received).toBe('周四');
  });

  it('returns valid for correct English weekday', () => {
    const result = validateDateWeekday('2026-04-15', 'Wednesday', 'en');
    expect(result.valid).toBe(true);
    expect(result.expected).toBe('Wednesday');
  });

  it('returns invalid for wrong English weekday', () => {
    const result = validateDateWeekday('2026-04-15', 'Thursday', 'en');
    expect(result.valid).toBe(false);
    expect(result.expected).toBe('Wednesday');
    expect(result.received).toBe('Thursday');
  });
});

describe('scanEmailForDateWeekdayErrors', () => {
  // Use Oct 15, 2026 = Thursday, Oct 16, 2026 = Friday (future-proof dates)
  it('returns no errors for correct Chinese date-weekday', () => {
    const email = '请您在10月15日（周四）下午2点来面试。';
    const errors = scanEmailForDateWeekdayErrors(email, 'zh');
    expect(errors).toHaveLength(0);
  });

  it('returns error for wrong Chinese weekday', () => {
    const email = '请您在10月15日（周三）下午2点来面试。';
    const errors = scanEmailForDateWeekdayErrors(email, 'zh');
    expect(errors).toHaveLength(1);
    expect(errors[0].claimedWeekday).toBe('周三');
    expect(errors[0].correctWeekday).toBe('周四');
  });

  it('returns only wrong entries with multiple dates', () => {
    // Oct 15 = Thursday, Oct 16 = Friday
    const email = '10月15日（周四）和10月16日（周六）休息。';
    const errors = scanEmailForDateWeekdayErrors(email, 'zh');
    expect(errors).toHaveLength(1);
    expect(errors[0].dateStr).toMatch(/10-16$/);
    expect(errors[0].claimedWeekday).toBe('周六');
    expect(errors[0].correctWeekday).toBe('周五');
  });

  it('returns no errors for correct English date-weekday', () => {
    const email = 'Please come on October 15 (Thursday) at 2 PM.';
    const errors = scanEmailForDateWeekdayErrors(email, 'en');
    expect(errors).toHaveLength(0);
  });

  it('returns error for wrong English weekday', () => {
    const email = 'Please come on October 15 (Wednesday) at 2 PM.';
    const errors = scanEmailForDateWeekdayErrors(email, 'en');
    expect(errors).toHaveLength(1);
    expect(errors[0].claimedWeekday).toBe('Wednesday');
    expect(errors[0].correctWeekday).toBe('Thursday');
  });
});

describe('validateApproval', () => {
  beforeEach(() => {
    mockIsApprovalRequired.mockReset();
  });

  it('returns invalid when approval required but not given', () => {
    mockIsApprovalRequired.mockReturnValue(true);
    const candidate = makeCandidate(CandidateState.ScreenedPass);
    const result = validateApproval(candidate, CandidateState.Scheduling, false);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Approval required for transition to scheduling');
  });

  it('returns valid when approval required and given', () => {
    mockIsApprovalRequired.mockReturnValue(true);
    const candidate = makeCandidate(CandidateState.ScreenedPass);
    const result = validateApproval(candidate, CandidateState.Scheduling, true);
    expect(result.valid).toBe(true);
  });

  it('returns valid when approval not required even if not approved', () => {
    mockIsApprovalRequired.mockReturnValue(false);
    const candidate = makeCandidate(CandidateState.New);
    const result = validateApproval(candidate, CandidateState.Screening, false);
    expect(result.valid).toBe(true);
  });
});

describe('validateIcs', () => {
  const validIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'DTSTART:20260415T140000Z',
    'DTEND:20260415T150000Z',
    'SUMMARY:Interview',
    'UID:abc-123@ai-recruiter',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('returns no errors for valid ICS', () => {
    const errors = validateIcs(validIcs);
    expect(errors).toHaveLength(0);
  });

  it('reports missing DTSTART', () => {
    const ics = validIcs.replace('DTSTART:20260415T140000Z\r\n', '');
    const errors = validateIcs(ics);
    expect(errors.some((e) => e.includes('DTSTART'))).toBe(true);
  });

  it('reports missing UID', () => {
    const ics = validIcs.replace('UID:abc-123@ai-recruiter\r\n', '');
    const errors = validateIcs(ics);
    expect(errors.some((e) => e.includes('UID'))).toBe(true);
  });

  it('reports DTSTART after DTEND', () => {
    const ics = validIcs
      .replace('DTSTART:20260415T140000Z', 'DTSTART:20260415T160000Z')
      .replace('DTEND:20260415T150000Z', 'DTEND:20260415T150000Z');
    const errors = validateIcs(ics);
    expect(errors.some((e) => e.includes('DTSTART must be before DTEND'))).toBe(true);
  });
});

describe('validateThreadIntegrity', () => {
  it('returns valid for matching IDs', () => {
    const result = validateThreadIntegrity('conv-001', 'conv-001');
    expect(result.valid).toBe(true);
  });

  it('returns invalid for mismatched IDs', () => {
    const result = validateThreadIntegrity('conv-001', 'conv-002');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Thread mismatch');
  });
});

describe('validateScores', () => {
  const framework = makeFramework();

  it('returns valid when all dimensions present with correct scores', () => {
    const scores: Record<string, DimensionScore> = {
      technical: { score: 4, evidence: 'good' },
      communication: { score: 3, evidence: 'ok' },
    };
    const result = validateScores(scores, framework);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports missing dimension', () => {
    const scores: Record<string, DimensionScore> = {
      technical: { score: 4, evidence: 'good' },
    };
    const result = validateScores(scores, framework);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('communication'))).toBe(true);
  });

  it('reports score of 0 as invalid', () => {
    const scores: Record<string, DimensionScore> = {
      technical: { score: 0, evidence: 'bad' },
      communication: { score: 3, evidence: 'ok' },
    };
    const result = validateScores(scores, framework);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('technical') && e.includes('1-5'))).toBe(true);
  });

  it('reports score of 6 as invalid', () => {
    const scores: Record<string, DimensionScore> = {
      technical: { score: 6, evidence: 'off scale' },
      communication: { score: 3, evidence: 'ok' },
    };
    const result = validateScores(scores, framework);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('technical') && e.includes('1-5'))).toBe(true);
  });

  it('reports extra dimension not in framework', () => {
    const scores: Record<string, DimensionScore> = {
      technical: { score: 4, evidence: 'good' },
      communication: { score: 3, evidence: 'ok' },
      creativity: { score: 5, evidence: 'wow' },
    };
    const result = validateScores(scores, framework);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('creativity') && e.includes('Extra'))).toBe(true);
  });
});

describe('computeWeightedAverage', () => {
  it('computes correctly for 2 dimensions', () => {
    const framework = makeFramework();
    const scores: Record<string, DimensionScore> = {
      technical: { score: 4, evidence: '' },
      communication: { score: 3, evidence: '' },
    };
    // (4*0.6 + 3*0.4) / 5 = (2.4 + 1.2) / 5 = 3.6 / 5 = 0.72
    expect(computeWeightedAverage(scores, framework)).toBe(0.72);
  });
});

describe('runPreflight', () => {
  beforeEach(() => {
    mockIsApprovalRequired.mockReset();
  });

  it('fails recruit_schedule with bad date-weekday', () => {
    // Oct 15, 2026 = Thursday; claiming 周三 (Wednesday) is wrong
    const checks = runPreflight('recruit_schedule', {
      emailBody: '10月15日（周三）下午2点来面试。',
      language: 'zh',
      conversationId: 'conv-001',
      candidateConversationId: 'conv-001',
    });
    const dateCheck = checks.find((c) => c.rule === 'date_weekday_valid');
    expect(dateCheck).toBeDefined();
    expect(dateCheck!.passed).toBe(false);
  });

  it('fails recruit_score with unconfirmed framework', () => {
    const framework = makeFramework(false);
    const scores: Record<string, DimensionScore> = {
      technical: { score: 4, evidence: '' },
      communication: { score: 3, evidence: '' },
    };
    const checks = runPreflight('recruit_score', {
      scores,
      framework,
    });
    const fwCheck = checks.find((c) => c.rule === 'framework_confirmed');
    expect(fwCheck).toBeDefined();
    expect(fwCheck!.passed).toBe(false);
    expect(fwCheck!.message).toContain('not confirmed');
  });
});

describe('runPostflight', () => {
  it('passes when state changed', () => {
    const checks = runPostflight('recruit_decide', {
      beforeState: 'screened_pass',
      afterState: 'scheduling',
    });
    expect(checks[0].passed).toBe(true);
  });

  it('fails when state unchanged', () => {
    const checks = runPostflight('recruit_decide', {
      beforeState: 'screened_pass',
      afterState: 'screened_pass',
    });
    expect(checks[0].passed).toBe(false);
    expect(checks[0].message).toContain('not updated');
  });
});

describe('scanEmailForPlaceholders', () => {
  it('detects [SLOTS] placeholder', () => {
    const result = scanEmailForPlaceholders('Hello,\n\nHere are the available slots:\n[SLOTS]\n\nBest');
    expect(result).toEqual(['[SLOTS]']);
  });

  it('detects [SLOT] singular', () => {
    const result = scanEmailForPlaceholders('Please pick from [SLOT]');
    expect(result).toEqual(['[SLOT]']);
  });

  it('detects [CANDIDATE_NAME]', () => {
    const result = scanEmailForPlaceholders('Dear [CANDIDATE_NAME],');
    expect(result).toEqual(['[CANDIDATE_NAME]']);
  });

  it('detects multiple placeholders', () => {
    const result = scanEmailForPlaceholders('Dear [CANDIDATE_NAME],\n\n[SLOTS]\n\n[SIGNATURE]');
    expect(result).toHaveLength(3);
    expect(result).toContain('[CANDIDATE_NAME]');
    expect(result).toContain('[SLOTS]');
    expect(result).toContain('[SIGNATURE]');
  });

  it('returns empty for clean email', () => {
    const result = scanEmailForPlaceholders('Dear Alice,\n\nHere are three available times:\n1. April 16 10:00-11:00\n\nBest,\nQuan');
    expect(result).toEqual([]);
  });

  it('is case-insensitive', () => {
    const result = scanEmailForPlaceholders('Here: [slots]');
    expect(result).toEqual(['[slots]']);
  });
});

describe('preflight rejects placeholders', () => {
  it('recruit_schedule rejects email body with [SLOTS]', () => {
    const checks = runPreflight('recruit_schedule', {
      emailBody: 'Hello, here are slots:\n[SLOTS]',
      language: 'en',
      conversationId: 'conv-1',
      candidateConversationId: 'conv-1',
    });
    const placeholderCheck = checks.find((c) => c.rule === 'no_placeholders');
    expect(placeholderCheck).toBeDefined();
    expect(placeholderCheck!.passed).toBe(false);
    expect(placeholderCheck!.message).toContain('[SLOTS]');
  });

  it('recruit_decide rejects email body with [CANDIDATE_NAME]', () => {
    const candidate = {
      schema_version: 1,
      candidate_id: 'c-1',
      name: 'Alice',
      channels: { primary: 'email', email: 'a@b.com' },
      role: 'swe',
      state: CandidateState.DecisionPending,
      state_updated: '2026-01-01T00:00:00Z',
      pending_action: '',
      conversation_id: 'conv-1',
      scores: { overall: 0.8, dimensions: {} },
      evaluations: [],
      offered_slots: [],
      portfolio_urls: [],
      timeline: [],
      created_at: '2026-01-01T00:00:00Z',
    };
    mockIsApprovalRequired.mockReturnValue(false);
    const checks = runPreflight('recruit_decide', {
      candidate,
      targetState: CandidateState.Hired,
      approved: true,
      emailBody: 'Dear [CANDIDATE_NAME], congrats!',
      language: 'en',
      conversationId: 'conv-1',
      candidateConversationId: 'conv-1',
    });
    const placeholderCheck = checks.find((c) => c.rule === 'no_placeholders');
    expect(placeholderCheck).toBeDefined();
    expect(placeholderCheck!.passed).toBe(false);
    expect(placeholderCheck!.message).toContain('[CANDIDATE_NAME]');
  });

  it('recruit_schedule passes clean email body', () => {
    const checks = runPreflight('recruit_schedule', {
      emailBody: 'Hello Alice, here are times:\n1. October 16 (Friday) 10:00-11:00',
      language: 'en',
      conversationId: 'conv-1',
      candidateConversationId: 'conv-1',
    });
    const placeholderCheck = checks.find((c) => c.rule === 'no_placeholders');
    expect(placeholderCheck).toBeDefined();
    expect(placeholderCheck!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateIcs: METHOD:CANCEL support
// ---------------------------------------------------------------------------

describe('validateIcs METHOD:CANCEL support', () => {
  it('accepts METHOD:CANCEL', () => {
    const cancelIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'METHOD:CANCEL',
      'BEGIN:VEVENT',
      'UID:test-uid@ai-recruiter',
      'DTSTART:20260420T100000Z',
      'DTEND:20260420T110000Z',
      'SUMMARY:Interview Cancelled',
      'STATUS:CANCELLED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const errors = validateIcs(cancelIcs);
    expect(errors).toEqual([]);
  });

  it('rejects ICS with no METHOD', () => {
    const noMethodIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:test-uid@ai-recruiter',
      'DTSTART:20260420T100000Z',
      'DTEND:20260420T110000Z',
      'SUMMARY:Interview',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const errors = validateIcs(noMethodIcs);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('METHOD'))).toBe(true);
  });
});
