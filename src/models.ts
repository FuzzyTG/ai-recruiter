// ---------------------------------------------------------------------------
// CandidateState Enum
// ---------------------------------------------------------------------------

export enum CandidateState {
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

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

const TERMINAL_STATES: ReadonlySet<CandidateState> = new Set([
  CandidateState.Hired,
  CandidateState.Rejected,
  CandidateState.Withdrawn,
  CandidateState.NoShow,
]);

// ---------------------------------------------------------------------------
// Valid transitions map
// ---------------------------------------------------------------------------

export const VALID_TRANSITIONS = new Map<CandidateState, Set<CandidateState>>([
  [CandidateState.New, new Set<CandidateState>([CandidateState.Screening])],
  [CandidateState.Screening, new Set<CandidateState>([CandidateState.ScreenedPass, CandidateState.ScreenedReject])],
  [CandidateState.ScreenedPass, new Set<CandidateState>([CandidateState.Scheduling])],
  [CandidateState.Scheduling, new Set<CandidateState>([CandidateState.InterviewConfirmed, CandidateState.Scheduling, CandidateState.ScreenedPass])],
  [CandidateState.InterviewConfirmed, new Set<CandidateState>([CandidateState.InterviewDone, CandidateState.NoShow, CandidateState.Scheduling])],
  [CandidateState.InterviewDone, new Set<CandidateState>([CandidateState.Evaluating])],
  [CandidateState.Evaluating, new Set<CandidateState>([
    CandidateState.Scheduling,
    CandidateState.HomeworkAssigned,
    CandidateState.Calibration,
    CandidateState.Rejected,
  ])],
  [CandidateState.HomeworkAssigned, new Set<CandidateState>([CandidateState.HomeworkSubmitted, CandidateState.HomeworkOverdue])],
  [CandidateState.HomeworkOverdue, new Set<CandidateState>([CandidateState.HomeworkSubmitted, CandidateState.Rejected])],
  [CandidateState.HomeworkSubmitted, new Set<CandidateState>([CandidateState.Evaluating, CandidateState.Scheduling])],
  [CandidateState.Calibration, new Set<CandidateState>([CandidateState.DecisionPending])],
  [CandidateState.DecisionPending, new Set<CandidateState>([CandidateState.Hired, CandidateState.Rejected])],
]);

// ---------------------------------------------------------------------------
// Approval-required transitions
// ---------------------------------------------------------------------------

export const APPROVAL_REQUIRED_TRANSITIONS: ReadonlyArray<{
  from?: CandidateState;
  to: CandidateState;
}> = [
  { to: CandidateState.Scheduling },
  { to: CandidateState.Rejected },
  { to: CandidateState.HomeworkAssigned },
  { from: CandidateState.Evaluating, to: CandidateState.Scheduling },
  { from: CandidateState.Scheduling, to: CandidateState.ScreenedPass },
  { from: CandidateState.InterviewConfirmed, to: CandidateState.Scheduling },
  { from: CandidateState.InterviewConfirmed, to: CandidateState.NoShow },
];

// ---------------------------------------------------------------------------
// Timeout rules
// ---------------------------------------------------------------------------

export interface TimeoutRule {
  state: CandidateState;
  hours: number;
  action: 'auto_followup' | 'notify_hm' | 'auto_transition';
  description: string;
  targetState?: CandidateState;
  relativeTo?: 'state_updated' | 'homework_deadline' | 'latest_slot_end' | 'earliest_slot_start' | 'interview_date';
}

export const TIMEOUT_RULES: readonly TimeoutRule[] = [
  // Scheduling: remind candidate 24h before earliest slot
  {
    state: CandidateState.Scheduling,
    hours: -24,
    action: 'auto_followup',
    description: 'Remind candidate about upcoming interview slots',
    relativeTo: 'earliest_slot_start',
  },
  // Scheduling: all slots expired, escalate to HM
  {
    state: CandidateState.Scheduling,
    hours: 2,
    action: 'notify_hm',
    description: 'All proposed slots expired, HM decides next step',
    relativeTo: 'latest_slot_end',
  },
  // Homework: auto-transition to overdue at deadline
  {
    state: CandidateState.HomeworkAssigned,
    hours: 0,
    action: 'auto_transition',
    description: 'Homework deadline passed, mark overdue',
    targetState: CandidateState.HomeworkOverdue,
    relativeTo: 'homework_deadline',
  },
  // Homework: notify HM 8h after deadline to decide (extend or reject)
  {
    state: CandidateState.HomeworkAssigned,
    hours: 8,
    action: 'notify_hm',
    description: 'Homework overdue, HM decides: extend deadline or reject',
    relativeTo: 'homework_deadline',
  },
  // Interview done: remind HM to evaluate after 3 days
  {
    state: CandidateState.InterviewDone,
    hours: 72,
    action: 'notify_hm',
    description: 'Remind HM to evaluate interview (3 days since interview)',
    relativeTo: 'interview_date',
  },
  // Evaluating: remind HM to decide after 3 days
  {
    state: CandidateState.Evaluating,
    hours: 72,
    action: 'notify_hm',
    description: 'Remind HM to make hiring decision',
  },
];

// ---------------------------------------------------------------------------
// Data interfaces
// ---------------------------------------------------------------------------

export interface Config {
  schema_version: number;
  hm_name: string;
  company_name: string;
  sender_name: string;
  cc_email: string;
  agentmail_inbox_id: string;
  calendar_url: string;
  meeting_link: string;
  signature_template: string;
  timezone: string;
  language: string;
  created_at: string;
}

export interface Dimension {
  name: string;
  weight: number; // 0-1
  rubric: string;
  description: string;
}

export interface Framework {
  schema_version: number;
  role: string;
  role_display: string;
  dimensions: Dimension[];
  confirmed: boolean;
  created_at: string;
}

export interface DimensionScore {
  score: number; // 1-5
  evidence: string;
}

export interface Evaluation {
  round: number;
  interviewer: string;
  scores: Record<string, DimensionScore>;
  input_type: 'free_form' | 'structured' | 'rubric_based';
  timestamp: string;
}

export interface TimelineEntry {
  timestamp: string;
  event: string;
  details?: Record<string, unknown>;
}

export interface OfferedSlot {
  start: string;
  end: string;
  offered_at: string;
  candidate_id: string;
}

export interface ConfirmedInterview {
  ics_uid: string;
  start: string;  // ISO 8601
  end: string;    // ISO 8601
}

export interface Candidate {
  schema_version: number;
  candidate_id: string; // C-YYYYMMDD-NNN
  name: string;
  channels: {
    primary: 'email';
    email: string;
    wechat?: string;
    telegram?: string;
    phone?: string;
  };
  role: string;
  state: CandidateState;
  state_updated: string;
  pending_action: string;
  conversation_id: string;
  scores: { overall: number; dimensions: Record<string, DimensionScore> } | null;
  evaluations: Evaluation[];
  offered_slots: OfferedSlot[];
  portfolio_urls?: string[];   // V2: candidate portfolio/website URLs for automated evaluation
  confirmed_interview?: ConfirmedInterview;  // set on confirm, cleared on cancel
  homework_deadline?: string;  // ISO 8601 -- set by send_homework, used by timeout rules
  timeline: TimelineEntry[];
  created_at: string;
}

export interface ConversationMessage {
  schema_version: number;
  message_id: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  timestamp: string;
  agentmail_thread_id?: string;
  in_reply_to?: string;
}

export interface AuditEntry {
  timestamp: string;
  tool: string;
  action: string;
  role?: string;
  candidate_id?: string;
  details: Record<string, unknown>;
  actor: 'system' | 'hm';
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function isTerminalState(state: CandidateState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isValidTransition(from: CandidateState, to: CandidateState): boolean {
  // Terminal states cannot transition to anything
  if (isTerminalState(from)) {
    return false;
  }

  // Check the explicit transitions map
  const allowed = VALID_TRANSITIONS.get(from);
  if (allowed && allowed.has(to)) {
    return true;
  }

  // Universal transitions: any non-terminal state can go to withdrawn or rejected
  if (to === CandidateState.Withdrawn || to === CandidateState.Rejected) {
    return true;
  }

  return false;
}

export function isApprovalRequired(from: CandidateState, to: CandidateState): boolean {
  // Note: evaluating → scheduling is a subset of the first rule (* → scheduling)
  if (to === CandidateState.Scheduling) return true;
  if (to === CandidateState.Rejected) return true;
  if (to === CandidateState.HomeworkAssigned) return true;
  if (from === CandidateState.Scheduling && to === CandidateState.ScreenedPass) return true;
  if (from === CandidateState.InterviewConfirmed && to === CandidateState.NoShow) return true;
  return false;
}

export function getTimeoutRules(state: CandidateState): TimeoutRule[] {
  return TIMEOUT_RULES.filter((rule) => rule.state === state);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export function generateCandidateId(): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  return `C-${yyyy}${mm}${dd}-001`;
}
