import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  RecruiterStore,
  SetupRequiredError,
  RoleNotFoundError,
  CandidateNotFoundError,
  IllegalTransitionError,
  ApprovalRequiredError,
} from '../src/store.js';

import {
  CandidateState,
  type Candidate,
  type Config,
  type Framework,
  type ConversationMessage,
  type OfferedSlot,
  type TimeoutRule,
} from '../src/models.js';

// ── Test Helpers ─────────────────────────────────────────────────────────────

const makeCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  schema_version: 1,
  candidate_id: 'C-20260414-001',
  name: 'Test Candidate',
  channels: { primary: 'email' as const, email: 'test@example.com' },
  role: 'test-role',
  state: CandidateState.New,
  state_updated: new Date().toISOString(),
  pending_action: 'Screen resume',
  conversation_id: 'conv-001',
  scores: null,
  evaluations: [],
  offered_slots: [],
  timeline: [],
  created_at: new Date().toISOString(),
  ...overrides,
});

const makeConfig = (): Config =>
  ({
    company_name: 'Acme Corp',
    hm_name: 'Alex Yuan',
    hm_email: 'alex@acme.com',
    timezone: 'America/Los_Angeles',
  }) as Config;

const makeFramework = (): Framework =>
  ({
    role: 'senior-engineer',
    dimensions: [
      { name: 'technical', weight: 0.5 },
      { name: 'culture', weight: 0.5 },
    ],
  }) as Framework;

// ── Test Suite ───────────────────────────────────────────────────────────────

let tmpDir: string;
let store: RecruiterStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruiter-test-'));
  store = new RecruiterStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. Config CRUD ──────────────────────────────────────────────────────────

describe('Config CRUD', () => {
  it('should throw SetupRequiredError when reading before write', () => {
    expect(() => store.readConfig()).toThrow(SetupRequiredError);
  });

  it('should write and read config', () => {
    const config = makeConfig();
    store.writeConfig(config);
    expect(store.configExists()).toBe(true);
    const read = store.readConfig();
    expect(read.company_name).toBe('Acme Corp');
    expect(read.hm_email).toBe('alex@acme.com');
  });

  it('should report configExists false before write', () => {
    expect(store.configExists()).toBe(false);
  });
});

// ── 2. Framework CRUD ───────────────────────────────────────────────────────

describe('Framework CRUD', () => {
  it('should throw RoleNotFoundError for nonexistent role', () => {
    expect(() => store.readFramework('nonexistent')).toThrow(
      RoleNotFoundError,
    );
  });

  it('should write and read framework', () => {
    const fw = makeFramework();
    store.writeFramework('senior-engineer', fw);
    const read = store.readFramework('senior-engineer');
    expect(read.role).toBe('senior-engineer');
    expect(read.dimensions).toHaveLength(2);
  });
});

// ── 3. listRoles ────────────────────────────────────────────────────────────

describe('listRoles', () => {
  it('should return empty array when no roles exist', () => {
    expect(store.listRoles()).toEqual([]);
  });

  it('should return correct slugs after creating multiple roles', () => {
    store.writeFramework('role-a', makeFramework());
    store.writeFramework('role-b', makeFramework());
    store.writeFramework('role-c', makeFramework());
    const roles = store.listRoles().sort();
    expect(roles).toEqual(['role-a', 'role-b', 'role-c']);
  });
});

// ── 4. Candidate CRUD ───────────────────────────────────────────────────────

describe('Candidate CRUD', () => {
  it('should throw CandidateNotFoundError for missing candidate', () => {
    expect(() => store.readCandidate('test-role', 'C-20260414-999')).toThrow(
      CandidateNotFoundError,
    );
  });

  it('should write and read candidate', () => {
    const candidate = makeCandidate();
    store.writeCandidate('test-role', candidate);
    const read = store.readCandidate('test-role', 'C-20260414-001');
    expect(read.name).toBe('Test Candidate');
    expect(read.state).toBe(CandidateState.New);
  });

  it('should list all candidates for a role', () => {
    store.writeCandidate(
      'test-role',
      makeCandidate({ candidate_id: 'C-20260414-001', name: 'Alice' }),
    );
    store.writeCandidate(
      'test-role',
      makeCandidate({ candidate_id: 'C-20260414-002', name: 'Bob' }),
    );
    const list = store.listCandidates('test-role');
    expect(list).toHaveLength(2);
    const names = list.map((c) => c.name).sort();
    expect(names).toEqual(['Alice', 'Bob']);
  });
});

// ── 5. transitionState — happy path ─────────────────────────────────────────

describe('transitionState — happy path', () => {
  it('should transition new → screening → screened_pass → scheduling → interview_confirmed', () => {
    const candidate = makeCandidate();
    store.writeCandidate('test-role', candidate);

    let updated = store.transitionState(
      'test-role',
      'C-20260414-001',
      CandidateState.Screening,
    );
    expect(updated.state).toBe(CandidateState.Screening);

    updated = store.transitionState(
      'test-role',
      'C-20260414-001',
      CandidateState.ScreenedPass,
    );
    expect(updated.state).toBe(CandidateState.ScreenedPass);

    updated = store.transitionState(
      'test-role',
      'C-20260414-001',
      CandidateState.Scheduling,
      { approved: true },
    );
    expect(updated.state).toBe(CandidateState.Scheduling);

    updated = store.transitionState(
      'test-role',
      'C-20260414-001',
      CandidateState.InterviewConfirmed,
    );
    expect(updated.state).toBe(CandidateState.InterviewConfirmed);
  });
});

// ── 6. transitionState — illegal ────────────────────────────────────────────

describe('transitionState — illegal', () => {
  it('should throw IllegalTransitionError for new → hired', () => {
    store.writeCandidate('test-role', makeCandidate());
    expect(() =>
      store.transitionState(
        'test-role',
        'C-20260414-001',
        CandidateState.Hired,
      ),
    ).toThrow(IllegalTransitionError);
  });
});

// ── 7. transitionState — approval gate ──────────────────────────────────────

describe('transitionState — approval gate', () => {
  it('should throw ApprovalRequiredError for screened_pass → scheduling without approval', () => {
    store.writeCandidate(
      'test-role',
      makeCandidate({ state: CandidateState.ScreenedPass }),
    );
    expect(() =>
      store.transitionState(
        'test-role',
        'C-20260414-001',
        CandidateState.Scheduling,
      ),
    ).toThrow(ApprovalRequiredError);
  });
});

// ── 8. transitionState — universal transitions ──────────────────────────────

describe('transitionState — universal transitions', () => {
  it('should allow evaluating → withdrawn', () => {
    store.writeCandidate(
      'test-role',
      makeCandidate({ state: CandidateState.Evaluating }),
    );
    const updated = store.transitionState(
      'test-role',
      'C-20260414-001',
      CandidateState.Withdrawn,
    );
    expect(updated.state).toBe(CandidateState.Withdrawn);
  });

  it('should require approval for universal → rejected', () => {
    store.writeCandidate(
      'test-role',
      makeCandidate({ state: CandidateState.Scheduling }),
    );
    expect(() =>
      store.transitionState(
        'test-role',
        'C-20260414-001',
        CandidateState.Rejected,
      ),
    ).toThrow(ApprovalRequiredError);
  });

  it('should allow universal → rejected with approval', () => {
    store.writeCandidate(
      'test-role',
      makeCandidate({ state: CandidateState.Scheduling }),
    );
    const updated = store.transitionState(
      'test-role',
      'C-20260414-001',
      CandidateState.Rejected,
      { approved: true },
    );
    expect(updated.state).toBe(CandidateState.Rejected);
  });
});

// ── 9. transitionState — terminal ───────────────────────────────────────────

describe('transitionState — terminal', () => {
  it('should throw IllegalTransitionError from hired to any state', () => {
    store.writeCandidate(
      'test-role',
      makeCandidate({ state: CandidateState.Hired }),
    );
    expect(() =>
      store.transitionState(
        'test-role',
        'C-20260414-001',
        CandidateState.New,
      ),
    ).toThrow(IllegalTransitionError);
  });
});

// ── 10. transitionState — timeline ──────────────────────────────────────────

describe('transitionState — timeline', () => {
  it('should grow timeline by 1 with correct event string on each transition', () => {
    store.writeCandidate('test-role', makeCandidate());

    store.transitionState(
      'test-role',
      'C-20260414-001',
      CandidateState.Screening,
    );
    let cand = store.readCandidate('test-role', 'C-20260414-001');
    expect(cand.timeline).toHaveLength(1);
    expect(cand.timeline[0].event).toBe(
      `${CandidateState.New} → ${CandidateState.Screening}`,
    );

    store.transitionState(
      'test-role',
      'C-20260414-001',
      CandidateState.ScreenedPass,
    );
    cand = store.readCandidate('test-role', 'C-20260414-001');
    expect(cand.timeline).toHaveLength(2);
    expect(cand.timeline[1].event).toBe(
      `${CandidateState.Screening} → ${CandidateState.ScreenedPass}`,
    );
  });
});

// ── 11. Atomic write safety ─────────────────────────────────────────────────

describe('Atomic write safety', () => {
  it('should not leave .tmp file after write', () => {
    const config = makeConfig();
    store.writeConfig(config);
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ── 12. generateCandidateId ─────────────────────────────────────────────────

describe('generateCandidateId', () => {
  it('should return C-YYYYMMDD-001 for first candidate', () => {
    const id = store.generateCandidateId('test-role');
    const today = new Date();
    const dateStr = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('');
    expect(id).toBe(`C-${dateStr}-001`);
  });

  it('should increment for subsequent candidates', () => {
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('');
    store.writeCandidate(
      'test-role',
      makeCandidate({ candidate_id: `C-${today}-001` }),
    );
    store.writeCandidate(
      'test-role',
      makeCandidate({ candidate_id: `C-${today}-002` }),
    );
    const id = store.generateCandidateId('test-role');
    expect(id).toBe(`C-${today}-003`);
  });
});

// ── 13. Resume operations ───────────────────────────────────────────────────

describe('Resume operations', () => {
  it('should write and read resume markdown', () => {
    const markdown = '# Resume\n\n## Experience\n- Engineer at Acme';
    store.writeResumeMarkdown('test-role', 'C-20260414-001', markdown);
    const read = store.readResumeMarkdown('test-role', 'C-20260414-001');
    expect(read).toBe(markdown);
  });

  it('should throw when reading nonexistent resume', () => {
    expect(() =>
      store.readResumeMarkdown('test-role', 'C-20260414-999'),
    ).toThrow();
  });
});

// ── 14. Conversation operations ─────────────────────────────────────────────

describe('Conversation operations', () => {
  it('should create, append 3 messages, read sorted, getLatest returns last', () => {
    store.createConversation('conv-test');

    const msg1: ConversationMessage = {
      direction: 'outbound',
      timestamp: '2026-04-14T10:00:00Z',
      content: 'Hello!',
    } as ConversationMessage;
    const msg2: ConversationMessage = {
      direction: 'inbound',
      timestamp: '2026-04-14T10:05:00Z',
      content: 'Hi there!',
    } as ConversationMessage;
    const msg3: ConversationMessage = {
      direction: 'outbound',
      timestamp: '2026-04-14T10:10:00Z',
      content: 'How are you?',
    } as ConversationMessage;

    store.appendMessage('conv-test', msg1);
    store.appendMessage('conv-test', msg2);
    store.appendMessage('conv-test', msg3);

    const messages = store.readConversation('conv-test');
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('Hello!');
    expect(messages[2].content).toBe('How are you?');

    const latest = store.getLatestMessage('conv-test');
    expect(latest).not.toBeNull();
    expect(latest!.content).toBe('How are you?');
  });

  it('should return null for getLatestMessage on empty conversation', () => {
    store.createConversation('conv-empty');
    const latest = store.getLatestMessage('conv-empty');
    expect(latest).toBeNull();
  });
});

// ── 15. Conversation message numbering ──────────────────────────────────────

describe('Conversation message numbering', () => {
  it('should name files 001-outbound.json, 002-inbound.json, etc.', () => {
    store.createConversation('conv-numbering');

    store.appendMessage('conv-numbering', {
      direction: 'outbound',
      timestamp: '2026-04-14T10:00:00Z',
      content: 'First',
    } as ConversationMessage);
    store.appendMessage('conv-numbering', {
      direction: 'inbound',
      timestamp: '2026-04-14T10:01:00Z',
      content: 'Second',
    } as ConversationMessage);
    store.appendMessage('conv-numbering', {
      direction: 'outbound',
      timestamp: '2026-04-14T10:02:00Z',
      content: 'Third',
    } as ConversationMessage);

    const convDir = path.join(tmpDir, 'conversations', 'conv-numbering');
    const files = fs.readdirSync(convDir).sort();
    expect(files).toEqual([
      '001-outbound.json',
      '002-inbound.json',
      '003-outbound.json',
    ]);
  });
});

// ── 16. Slot tracking ───────────────────────────────────────────────────────

describe('Slot tracking', () => {
  it('should mark, get, and release slots', () => {
    store.writeCandidate('test-role', makeCandidate());

    const slots: OfferedSlot[] = [
      { start: '2026-04-15T10:00:00Z', end: '2026-04-15T11:00:00Z' },
      { start: '2026-04-16T14:00:00Z', end: '2026-04-16T15:00:00Z' },
    ] as OfferedSlot[];

    store.markSlotsOffered('test-role', 'C-20260414-001', slots);

    const offered = store.getOfferedSlots('test-role');
    expect(offered).toHaveLength(2);

    store.releaseSlots('test-role', 'C-20260414-001');
    const after = store.getOfferedSlots('test-role');
    expect(after).toHaveLength(0);
  });
});

// ── 17. checkTimeouts ───────────────────────────────────────────────────────

describe('checkTimeouts', () => {
  it('should flag candidate in scheduling state with slots within 24h', () => {
    const now = Date.now();

    store.writeCandidate(
      'test-role',
      makeCandidate({
        state: CandidateState.Scheduling,
        state_updated: new Date(now - 50 * 60 * 60 * 1000).toISOString(),
        offered_slots: [
          {
            start: new Date(now + 20 * 60 * 60 * 1000).toISOString(),
            end: new Date(now + 21 * 60 * 60 * 1000).toISOString(),
            offered_at: new Date(now - 50 * 60 * 60 * 1000).toISOString(),
            candidate_id: 'C-20260414-001',
          },
        ],
      }),
    );

    const overdue = store.checkTimeouts('test-role');
    expect(overdue.length).toBeGreaterThanOrEqual(1);
    const followup = overdue.find((o) => o.rule.action === 'auto_followup');
    expect(followup).toBeDefined();
    expect(followup!.candidate.candidate_id).toBe('C-20260414-001');
  });
});

// ── 18. Audit logging ───────────────────────────────────────────────────────

describe('Audit logging', () => {
  it('should accumulate audit entries in audit.jsonl', () => {
    store.writeConfig(makeConfig());
    store.writeFramework('test-role', makeFramework());
    store.writeCandidate('test-role', makeCandidate());

    const auditPath = path.join(tmpDir, 'audit.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);

    const lines = fs
      .readFileSync(auditPath, 'utf-8')
      .trim()
      .split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Each line should be valid JSON
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('action');
    }
  });
});

// ── 19. Narrative ───────────────────────────────────────────────────────────

describe('Narrative', () => {
  it('should write and read narrative', () => {
    store.writeNarrative('test-role', 'C-20260414-001', 'First note.\n');
    const content = store.readNarrative('test-role', 'C-20260414-001');
    expect(content).toBe('First note.\n');
  });

  it('should append on second write', () => {
    store.writeNarrative('test-role', 'C-20260414-001', 'First note.\n');
    store.writeNarrative('test-role', 'C-20260414-001', 'Second note.\n');
    const content = store.readNarrative('test-role', 'C-20260414-001');
    expect(content).toBe('First note.\nSecond note.\n');
  });

  it('should return empty string for nonexistent narrative', () => {
    const content = store.readNarrative('test-role', 'C-20260414-999');
    expect(content).toBe('');
  });
});

// ── 20. JD ──────────────────────────────────────────────────────────────────

describe('JD', () => {
  it('should write and read JD', () => {
    store.writeJd('test-role', '# Senior Engineer\n\nWe are looking for...');
    const content = store.readJd('test-role');
    expect(content).toBe('# Senior Engineer\n\nWe are looking for...');
  });

  it('should return empty string for nonexistent JD', () => {
    expect(store.readJd('nonexistent-role')).toBe('');
  });
});

// ── 21. Directory creation ──────────────────────────────────────────────────

describe('Directory creation', () => {
  it('should auto-create directories for operations on new roles', () => {
    // Writing a candidate to a brand new role should create the directories
    store.writeCandidate('brand-new-role', makeCandidate());
    const candidatePath = path.join(
      tmpDir,
      'roles',
      'brand-new-role',
      'candidates',
      'C-20260414-001.json',
    );
    expect(fs.existsSync(candidatePath)).toBe(true);
  });

  it('should auto-create conversation directory', () => {
    store.createConversation('new-conv');
    const convDir = path.join(tmpDir, 'conversations', 'new-conv');
    expect(fs.existsSync(convDir)).toBe(true);
    expect(fs.statSync(convDir).isDirectory()).toBe(true);
  });
});

// ── 22. checkTimeouts with relativeTo ──────────────────────────────────────

describe('checkTimeouts with relativeTo', () => {
  it('uses earliest_slot_start for scheduling rules', () => {
    const now = Date.now();

    store.writeCandidate(
      'test-role',
      makeCandidate({
        state: CandidateState.Scheduling,
        state_updated: new Date(now - 50 * 60 * 60 * 1000).toISOString(),
        offered_slots: [
          {
            start: new Date(now + 20 * 60 * 60 * 1000).toISOString(),
            end: new Date(now + 21 * 60 * 60 * 1000).toISOString(),
            offered_at: new Date(now - 50 * 60 * 60 * 1000).toISOString(),
            candidate_id: 'C-20260414-001',
          },
        ],
      }),
    );

    const overdue = store.checkTimeouts('test-role');
    // scheduling -24h auto_followup rule should fire (20h < 24h)
    expect(overdue.length).toBeGreaterThanOrEqual(1);
    const followup = overdue.find((o) => o.rule.action === 'auto_followup');
    expect(followup).toBeDefined();
  });

  it('uses homework_deadline when relativeTo is homework_deadline', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    store.writeCandidate(
      'test-role',
      makeCandidate({
        state: CandidateState.HomeworkAssigned,
        state_updated: new Date().toISOString(), // just now
        homework_deadline: twoHoursAgo,
      }),
    );

    const overdue = store.checkTimeouts('test-role');
    // hours:0 rule should fire (deadline passed 2h ago), hours:8 should NOT
    const firedRules = overdue.map(o => o.rule.hours);
    expect(firedRules).toContain(0);
    expect(firedRules).not.toContain(8);
  });

  it('skips homework_deadline rule when no deadline set', () => {
    store.writeCandidate(
      'test-role',
      makeCandidate({
        state: CandidateState.HomeworkAssigned,
        state_updated: new Date().toISOString(),
        // homework_deadline intentionally omitted
      }),
    );

    const overdue = store.checkTimeouts('test-role');
    // No homework rules should fire since there's no deadline
    expect(overdue).toHaveLength(0);
  });

  it('homework notify_hm rule fires at deadline+8h', () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();

    store.writeCandidate(
      'test-role',
      makeCandidate({
        state: CandidateState.HomeworkAssigned,
        state_updated: new Date().toISOString(),
        homework_deadline: tenHoursAgo,
      }),
    );

    const overdue = store.checkTimeouts('test-role');
    // Both hours:0 (auto_transition) and hours:8 (notify_hm) rules should fire
    const firedRules = overdue.map(o => o.rule.hours);
    expect(firedRules).toContain(0);
    expect(firedRules).toContain(8);
  });

  it('does not fire for candidates in terminal states', () => {
    store.writeCandidate(
      'test-role',
      makeCandidate({
        state: CandidateState.Hired,
        state_updated: new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(),
      }),
    );

    const overdue = store.checkTimeouts('test-role');
    expect(overdue).toHaveLength(0);
  });
});
