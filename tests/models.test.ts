import { describe, it, expect } from 'vitest';
import {
  CandidateState,
  VALID_TRANSITIONS,
  TIMEOUT_RULES,
  isTerminalState,
  isValidTransition,
  isApprovalRequired,
  getTimeoutRules,
  slugify,
  generateCandidateId,
  type Candidate,
} from '../src/models.js';

// ---------------------------------------------------------------------------
// 1. Every valid transition returns true
// ---------------------------------------------------------------------------

describe('VALID_TRANSITIONS — every explicit transition is accepted', () => {
  for (const [from, toSet] of VALID_TRANSITIONS) {
    for (const to of toSet) {
      it(`${from} -> ${to}`, () => {
        expect(isValidTransition(from, to)).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Invalid transitions return false (at least 10 pairs)
// ---------------------------------------------------------------------------

describe('Invalid transitions return false', () => {
  const invalidPairs: [CandidateState, CandidateState][] = [
    [CandidateState.New, CandidateState.Hired],
    [CandidateState.New, CandidateState.Calibration],
    [CandidateState.Screening, CandidateState.Calibration],
    [CandidateState.Screening, CandidateState.InterviewDone],
    [CandidateState.ScreenedPass, CandidateState.Hired],
    [CandidateState.Scheduling, CandidateState.Hired],
    [CandidateState.InterviewConfirmed, CandidateState.Calibration],
    [CandidateState.InterviewDone, CandidateState.Hired],
    [CandidateState.Calibration, CandidateState.Scheduling],
    [CandidateState.DecisionPending, CandidateState.Screening],
    [CandidateState.HomeworkAssigned, CandidateState.Calibration],
    [CandidateState.HomeworkOverdue, CandidateState.Hired],
  ];

  for (const [from, to] of invalidPairs) {
    it(`${from} -> ${to} is invalid`, () => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Terminal states cannot transition to anything
// ---------------------------------------------------------------------------

describe('Terminal states block all outbound transitions', () => {
  const terminalStates = [
    CandidateState.Hired,
    CandidateState.Rejected,
    CandidateState.Withdrawn,
    CandidateState.NoShow,
  ];

  const targets = [
    CandidateState.New,
    CandidateState.Screening,
    CandidateState.Scheduling,
    CandidateState.Hired,
    CandidateState.Rejected,
    CandidateState.Withdrawn,
  ];

  for (const terminal of terminalStates) {
    for (const target of targets) {
      it(`${terminal} -> ${target} is blocked`, () => {
        expect(isValidTransition(terminal, target)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Universal transitions (-> withdrawn, -> rejected) from every non-terminal
// ---------------------------------------------------------------------------

describe('Universal transitions to withdrawn/rejected', () => {
  const nonTerminal = Object.values(CandidateState).filter(
    (s) => !isTerminalState(s),
  );

  for (const state of nonTerminal) {
    it(`${state} -> withdrawn`, () => {
      expect(isValidTransition(state, CandidateState.Withdrawn)).toBe(true);
    });
    it(`${state} -> rejected`, () => {
      expect(isValidTransition(state, CandidateState.Rejected)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Approval-required transitions correctly identified
// ---------------------------------------------------------------------------

describe('isApprovalRequired', () => {
  it('any -> scheduling requires approval', () => {
    expect(isApprovalRequired(CandidateState.ScreenedPass, CandidateState.Scheduling)).toBe(true);
  });

  it('any -> rejected requires approval', () => {
    expect(isApprovalRequired(CandidateState.Evaluating, CandidateState.Rejected)).toBe(true);
    expect(isApprovalRequired(CandidateState.DecisionPending, CandidateState.Rejected)).toBe(true);
  });

  it('any -> homework_assigned requires approval', () => {
    expect(isApprovalRequired(CandidateState.Evaluating, CandidateState.HomeworkAssigned)).toBe(true);
  });

  it('evaluating -> scheduling requires approval', () => {
    expect(isApprovalRequired(CandidateState.Evaluating, CandidateState.Scheduling)).toBe(true);
  });

  it('transitions that do NOT require approval', () => {
    expect(isApprovalRequired(CandidateState.New, CandidateState.Screening)).toBe(false);
    expect(isApprovalRequired(CandidateState.Screening, CandidateState.ScreenedPass)).toBe(false);
    expect(isApprovalRequired(CandidateState.Calibration, CandidateState.DecisionPending)).toBe(false);
    expect(isApprovalRequired(CandidateState.InterviewDone, CandidateState.Evaluating)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. isTerminalState returns true for exactly 4 states
// ---------------------------------------------------------------------------

describe('isTerminalState', () => {
  const allStates = Object.values(CandidateState);
  const terminalCount = allStates.filter(isTerminalState).length;

  it('exactly 4 terminal states exist', () => {
    expect(terminalCount).toBe(4);
  });

  it('Hired is terminal', () => expect(isTerminalState(CandidateState.Hired)).toBe(true));
  it('Rejected is terminal', () => expect(isTerminalState(CandidateState.Rejected)).toBe(true));
  it('Withdrawn is terminal', () => expect(isTerminalState(CandidateState.Withdrawn)).toBe(true));
  it('NoShow is terminal', () => expect(isTerminalState(CandidateState.NoShow)).toBe(true));
  it('New is NOT terminal', () => expect(isTerminalState(CandidateState.New)).toBe(false));
  it('Screening is NOT terminal', () => expect(isTerminalState(CandidateState.Screening)).toBe(false));
});

// ---------------------------------------------------------------------------
// 7. slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('handles spaces', () => {
    expect(slugify('hello world')).toBe('hello-world');
  });

  it('handles special characters', () => {
    expect(slugify('hello@world!')).toBe('hello-world');
  });

  it('collapses consecutive hyphens', () => {
    expect(slugify('hello---world')).toBe('hello-world');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('converts to lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('handles CJK characters without crashing', () => {
    const result = slugify('张三 面试');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // CJK chars should pass through
    expect(result).toContain('张');
    expect(result).toContain('三');
  });

  it('handles mixed CJK and ASCII', () => {
    const result = slugify('张三 Test 面试');
    expect(typeof result).toBe('string');
    expect(result).toContain('test');
  });

  it('handles empty-ish input', () => {
    expect(slugify('---')).toBe('');
    expect(slugify('!@#')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 8. Round-trip serialization of Candidate
// ---------------------------------------------------------------------------

describe('Candidate round-trip serialization', () => {
  it('JSON.stringify -> JSON.parse preserves all fields', () => {
    const candidate: Candidate = {
      schema_version: 1,
      candidate_id: 'C-20260414-001',
      name: 'Jane Doe',
      channels: {
        primary: 'email',
        email: 'jane@example.com',
        wechat: 'jane_wx',
      },
      role: 'Senior Engineer',
      state: CandidateState.Screening,
      state_updated: '2026-04-14T10:00:00Z',
      pending_action: 'await_screening_result',
      conversation_id: 'conv-001',
      scores: {
        overall: 4.2,
        dimensions: {
          coding: { score: 4, evidence: 'Solid fundamentals' },
          design: { score: 5, evidence: 'Excellent systems design' },
        },
      },
      evaluations: [
        {
          round: 1,
          interviewer: 'Alex',
          scores: {
            coding: { score: 4, evidence: 'Solid fundamentals' },
          },
          input_type: 'structured',
          timestamp: '2026-04-14T12:00:00Z',
        },
      ],
      offered_slots: [
        {
          start: '2026-04-15T09:00:00Z',
          end: '2026-04-15T10:00:00Z',
          offered_at: '2026-04-14T10:00:00Z',
          candidate_id: 'C-20260414-001',
        },
      ],
      timeline: [
        {
          timestamp: '2026-04-14T09:00:00Z',
          event: 'created',
          details: { source: 'manual' },
        },
      ],
      created_at: '2026-04-14T09:00:00Z',
    };

    const json = JSON.stringify(candidate);
    const parsed: Candidate = JSON.parse(json);

    expect(parsed.schema_version).toBe(candidate.schema_version);
    expect(parsed.candidate_id).toBe(candidate.candidate_id);
    expect(parsed.name).toBe(candidate.name);
    expect(parsed.channels).toEqual(candidate.channels);
    expect(parsed.role).toBe(candidate.role);
    expect(parsed.state).toBe(candidate.state);
    expect(parsed.state_updated).toBe(candidate.state_updated);
    expect(parsed.pending_action).toBe(candidate.pending_action);
    expect(parsed.conversation_id).toBe(candidate.conversation_id);
    expect(parsed.scores).toEqual(candidate.scores);
    expect(parsed.evaluations).toEqual(candidate.evaluations);
    expect(parsed.offered_slots).toEqual(candidate.offered_slots);
    expect(parsed.timeline).toEqual(candidate.timeline);
    expect(parsed.created_at).toBe(candidate.created_at);
  });

  it('handles null scores', () => {
    const candidate: Candidate = {
      schema_version: 1,
      candidate_id: 'C-20260414-002',
      name: 'John Smith',
      channels: { primary: 'email', email: 'john@example.com' },
      role: 'PM',
      state: CandidateState.New,
      state_updated: '2026-04-14T10:00:00Z',
      pending_action: '',
      conversation_id: 'conv-002',
      scores: null,
      evaluations: [],
      offered_slots: [],
      timeline: [],
      created_at: '2026-04-14T10:00:00Z',
    };

    const parsed: Candidate = JSON.parse(JSON.stringify(candidate));
    expect(parsed.scores).toBeNull();
    expect(parsed.evaluations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. getTimeoutRules returns correct rules / empty for non-matching states
// ---------------------------------------------------------------------------

describe('getTimeoutRules', () => {
  it('returns 2 rules for scheduling', () => {
    const rules = getTimeoutRules(CandidateState.Scheduling);
    expect(rules).toHaveLength(2);
    expect(rules[0].hours).toBe(-24);
    expect(rules[1].hours).toBe(2);
  });

  it('returns no rules for interview_confirmed (auto-transition removed)', () => {
    const rules = getTimeoutRules(CandidateState.InterviewConfirmed);
    expect(rules).toHaveLength(0);
  });

  it('returns 2 rules for homework_assigned', () => {
    const rules = getTimeoutRules(CandidateState.HomeworkAssigned);
    expect(rules).toHaveLength(2);
  });

  it('returns 1 rule for evaluating', () => {
    const rules = getTimeoutRules(CandidateState.Evaluating);
    expect(rules).toHaveLength(1);
    expect(rules[0].hours).toBe(72);
  });

  it('returns empty for states without rules', () => {
    expect(getTimeoutRules(CandidateState.New)).toHaveLength(0);
    expect(getTimeoutRules(CandidateState.Hired)).toHaveLength(0);
    expect(getTimeoutRules(CandidateState.Screening)).toHaveLength(0);
    expect(getTimeoutRules(CandidateState.Calibration)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. TIMEOUT_RULES has exactly 6 entries
// ---------------------------------------------------------------------------

describe('TIMEOUT_RULES count', () => {
  it('has exactly 6 entries', () => {
    expect(TIMEOUT_RULES).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Bonus: generateCandidateId stub
// ---------------------------------------------------------------------------

describe('generateCandidateId', () => {
  it('returns a string matching C-YYYYMMDD-001', () => {
    const id = generateCandidateId();
    expect(id).toMatch(/^C-\d{8}-001$/);
  });

  it('uses today\'s date', () => {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, '0');
    const dd = now.getDate().toString().padStart(2, '0');
    expect(generateCandidateId()).toBe(`C-${yyyy}${mm}${dd}-001`);
  });
});

// ---------------------------------------------------------------------------
// Cancel/reschedule backward transitions
// ---------------------------------------------------------------------------

describe('Backward transitions for cancel/reschedule', () => {
  it('interview_confirmed → scheduling is a valid transition', () => {
    expect(isValidTransition(CandidateState.InterviewConfirmed, CandidateState.Scheduling)).toBe(true);
  });

  it('scheduling → screened_pass is a valid transition', () => {
    expect(isValidTransition(CandidateState.Scheduling, CandidateState.ScreenedPass)).toBe(true);
  });

  it('interview_confirmed → scheduling requires approval', () => {
    expect(isApprovalRequired(CandidateState.InterviewConfirmed, CandidateState.Scheduling)).toBe(true);
  });

  it('scheduling → screened_pass requires approval', () => {
    expect(isApprovalRequired(CandidateState.Scheduling, CandidateState.ScreenedPass)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TimeoutRule relativeTo field
// ---------------------------------------------------------------------------

describe('TIMEOUT_RULES relativeTo field', () => {
  it('homework_assigned rules have relativeTo homework_deadline', () => {
    const rules = getTimeoutRules(CandidateState.HomeworkAssigned);
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.relativeTo).toBe('homework_deadline');
    }
  });

  it('scheduling rules have slot-aware relativeTo', () => {
    const rules = getTimeoutRules(CandidateState.Scheduling);
    const followup = rules.find((r) => r.action === 'auto_followup');
    const notify = rules.find((r) => r.action === 'notify_hm');
    expect(followup?.relativeTo).toBe('earliest_slot_start');
    expect(notify?.relativeTo).toBe('latest_slot_end');
  });

  it('interview_done rule exists with 72h notify_hm relative to interview_date', () => {
    const rules = getTimeoutRules(CandidateState.InterviewDone);
    expect(rules).toHaveLength(1);
    expect(rules[0].hours).toBe(72);
    expect(rules[0].action).toBe('notify_hm');
    expect(rules[0].relativeTo).toBe('interview_date');
  });
});

// ---------------------------------------------------------------------------
// Approval: interview_confirmed -> no_show
// ---------------------------------------------------------------------------

describe('Approval for interview_confirmed -> no_show', () => {
  it('interview_confirmed -> no_show requires approval', () => {
    expect(isApprovalRequired(CandidateState.InterviewConfirmed, CandidateState.NoShow)).toBe(true);
  });

  it('interview_confirmed -> interview_done does NOT require approval', () => {
    expect(isApprovalRequired(CandidateState.InterviewConfirmed, CandidateState.InterviewDone)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TIMEOUT_RULES coverage
// ---------------------------------------------------------------------------

describe('TIMEOUT_RULES cover all expected states', () => {
  it('has rules for scheduling, homework_assigned, interview_done, and evaluating', () => {
    const coveredStates = new Set(TIMEOUT_RULES.map((r) => r.state));
    expect(coveredStates.has(CandidateState.Scheduling)).toBe(true);
    expect(coveredStates.has(CandidateState.HomeworkAssigned)).toBe(true);
    expect(coveredStates.has(CandidateState.InterviewDone)).toBe(true);
    expect(coveredStates.has(CandidateState.Evaluating)).toBe(true);
  });
});
