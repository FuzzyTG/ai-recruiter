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
  ValidationError,
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

describe('Credentials', () => {
  it('round-trips a credential', () => {
    store.writeCredential('agentmail_api_key', 'am_test123');
    const creds = store.readCredentials();
    expect(creds.agentmail_api_key).toBe('am_test123');
  });

  it('returns empty object when no credentials file exists', () => {
    expect(store.readCredentials()).toEqual({});
  });

  it('returns empty object when credentials file is corrupted', () => {
    const credPath = path.join(tmpDir, '.credentials');
    fs.writeFileSync(credPath, 'not json!!!');
    expect(store.readCredentials()).toEqual({});
  });

  it('sets file permissions to 0600', () => {
    store.writeCredential('key', 'value');
    const credPath = path.join(tmpDir, '.credentials');
    const stat = fs.statSync(credPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('preserves existing credentials when adding new ones', () => {
    store.writeCredential('key1', 'val1');
    store.writeCredential('key2', 'val2');
    const creds = store.readCredentials();
    expect(creds.key1).toBe('val1');
    expect(creds.key2).toBe('val2');
  });
});

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

  it('migrates an unversioned framework to version 1', () => {
    const fw = makeFramework();
    store.writeFramework('senior-engineer', fw);

    const read = store.readFramework('senior-engineer');

    expect(read.framework_version).toBe(1);
    expect(read.active).toBe(true);
    expect(store.listFrameworkVersions('senior-engineer').map((v) => v.framework_version)).toEqual([1]);
  });

  it('durably backfills a legacy unversioned framework fixture when read', () => {
    const fwPath = path.join(tmpDir, 'roles', 'legacy-role', 'framework.json');
    fs.mkdirSync(path.dirname(fwPath), { recursive: true });
    fs.writeFileSync(fwPath, JSON.stringify({
      schema_version: 1,
      role: 'legacy-role',
      role_display: 'Legacy Role',
      dimensions: [
        { name: 'technical', weight: 0.5, rubric: 'Tech', description: 'Tech' },
        { name: 'culture', weight: 0.5, rubric: 'Culture', description: 'Culture' },
      ],
      confirmed: true,
      created_at: '2026-04-01T00:00:00.000Z',
    }, null, 2));

    const read = store.readFramework('legacy-role');
    const persisted = JSON.parse(fs.readFileSync(fwPath, 'utf-8'));

    expect(read.framework_version).toBe(1);
    expect(read.active).toBe(true);
    expect(persisted.framework_version).toBe(1);
    expect(persisted.active).toBe(true);
  });

  it('persists only the latest confirmed framework version as active', () => {
    store.writeFramework('senior-engineer', {
      ...makeFramework(),
      role: 'senior-engineer',
      confirmed: true,
      framework_version: 1,
    });
    store.writeFramework('senior-engineer', {
      ...makeFramework(),
      role: 'senior-engineer',
      confirmed: true,
      framework_version: 2,
      dimensions: [
        { name: 'technical', weight: 0.7 },
        { name: 'culture', weight: 0.3 },
      ],
    });

    const v1 = store.readFrameworkVersion('senior-engineer', 1);
    const v2 = store.readFrameworkVersion('senior-engineer', 2);
    const persistedV1 = JSON.parse(fs.readFileSync(path.join(tmpDir, 'roles', 'senior-engineer', 'framework.json'), 'utf-8'));
    const persistedV2 = JSON.parse(fs.readFileSync(path.join(tmpDir, 'roles', 'senior-engineer', 'frameworks', 'v2.json'), 'utf-8'));

    expect(v1.active).toBe(false);
    expect(v2.active).toBe(true);
    expect(persistedV1.active).toBe(false);
    expect(persistedV2.active).toBe(true);
  });

  it('blocks content mutation of a confirmed framework version', () => {
    store.writeFramework('senior-engineer', {
      ...makeFramework(),
      role: 'senior-engineer',
      role_display: 'Senior Engineer',
      confirmed: true,
      framework_version: 1,
      created_at: '2026-04-01T00:00:00.000Z',
    });

    expect(() => store.writeFramework('senior-engineer', {
      ...makeFramework(),
      role: 'senior-engineer',
      role_display: 'Senior Engineer',
      confirmed: true,
      framework_version: 1,
      created_at: '2026-04-01T00:00:00.000Z',
      dimensions: [
        { name: 'technical', weight: 0.7 },
        { name: 'culture', weight: 0.3 },
      ],
    })).toThrow(ValidationError);

    expect(store.readFrameworkVersion('senior-engineer', 1).dimensions).toEqual(makeFramework().dimensions);
  });

  it('allows metadata-only writes for a confirmed framework version', () => {
    store.writeFramework('senior-engineer', {
      ...makeFramework(),
      role: 'senior-engineer',
      role_display: 'Senior Engineer',
      confirmed: true,
      framework_version: 1,
      active: true,
      created_at: '2026-04-01T00:00:00.000Z',
    });

    store.writeFramework('senior-engineer', {
      ...makeFramework(),
      role: 'senior-engineer',
      role_display: 'Senior Engineer Display Backfill',
      confirmed: true,
      framework_version: 1,
      active: false,
      created_at: '2026-04-01T00:00:00.000Z',
    });

    const read = store.readFrameworkVersion('senior-engineer', 1);
    expect(read.role_display).toBe('Senior Engineer Display Backfill');
    expect(read.dimensions).toEqual(makeFramework().dimensions);
  });

  it('allows same-version metadata backfill for confirmed frameworks without changing immutable content', () => {
    store.writeFramework('senior-engineer', {
      ...makeFramework(),
      role: 'senior-engineer',
      role_display: 'Senior Engineer',
      confirmed: true,
      framework_version: 1,
      active: true,
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const before = store.readFrameworkVersion('senior-engineer', 1);

    store.writeFramework('senior-engineer', {
      ...before,
      role_display: 'Senior Engineer Display Backfill',
      active: false,
    });

    const read = store.readFrameworkVersion('senior-engineer', 1);
    expect(read.role_display).toBe('Senior Engineer Display Backfill');
    expect(read.dimensions).toEqual(before.dimensions);
    expect(read.confirmed).toBe(before.confirmed);
    expect(read.created_at).toBe(before.created_at);
  });

  it('backfills unversioned candidate scores and evaluations to framework version 1', () => {
    const candidate = makeCandidate({
      scores: {
        overall: 0.8,
        dimensions: {
          technical: { score: 4, evidence: 'Good' },
          culture: { score: 4, evidence: 'Good' },
        },
      },
      evaluations: [
        {
          round: 1,
          interviewer: 'Alice',
          scores: {
            technical: { score: 4, evidence: 'Good' },
            culture: { score: 4, evidence: 'Good' },
          },
          input_type: 'structured',
          timestamp: new Date().toISOString(),
        },
      ],
    });
    store.writeCandidate('test-role', candidate);

    const read = store.readCandidate('test-role', 'C-20260414-001');

    expect(read.scores?.framework_version).toBe(1);
    expect(read.evaluations[0].framework_version).toBe(1);
  });

  it('durably backfills legacy unversioned candidate scores and evaluations when read', () => {
    const candidatePath = path.join(tmpDir, 'roles', 'test-role', 'candidates', 'C-20260414-001.json');
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, JSON.stringify(makeCandidate({
      scores: {
        overall: 0.8,
        dimensions: {
          technical: { score: 4, evidence: 'Good' },
          culture: { score: 4, evidence: 'Good' },
        },
      } as Candidate['scores'],
      evaluations: [
        {
          round: 1,
          interviewer: 'Alice',
          scores: {
            technical: { score: 4, evidence: 'Good' },
            culture: { score: 4, evidence: 'Good' },
          },
          input_type: 'structured',
          timestamp: new Date().toISOString(),
        } as Candidate['evaluations'][number],
      ],
    }), null, 2));

    const read = store.readCandidate('test-role', 'C-20260414-001');
    const persisted = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));

    expect(read.scores?.framework_version).toBe(1);
    expect(read.evaluations[0].framework_version).toBe(1);
    expect(persisted.scores.framework_version).toBe(1);
    expect(persisted.evaluations[0].framework_version).toBe(1);
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
      { approved: true },
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
      { approved: true },
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

// ── 22. deleteCandidate ─────────────────────────────────────────────────────

describe('deleteCandidate', () => {
  function setupCandidateWithData(candidateId = 'C-20260414-001', conversationId = 'conv-C-20260414-001') {
    const candidate = makeCandidate({ candidate_id: candidateId, conversation_id: conversationId });
    store.writeCandidate('test-role', candidate);
    store.writeResumeMarkdown('test-role', candidateId, '# Resume content');
    store.writeNarrative('test-role', candidateId, 'Narrative notes\n');
    store.createConversation(conversationId);
    store.appendMessage(conversationId, {
      schema_version: 1,
      message_id: 'msg-001',
      direction: 'outbound',
      from: 'hm@test.com',
      to: ['candidate@test.com'],
      cc: [],
      subject: 'Test Subject',
      body: 'Test body',
      timestamp: new Date().toISOString(),
    });
    return candidate;
  }

  it('removes candidate JSON file', () => {
    setupCandidateWithData();
    store.deleteCandidate('test-role', 'C-20260414-001');
    expect(() => store.readCandidate('test-role', 'C-20260414-001')).toThrow(CandidateNotFoundError);
  });

  it('removes resume file', () => {
    setupCandidateWithData();
    store.deleteCandidate('test-role', 'C-20260414-001');
    const resumePath = path.join(tmpDir, 'roles', 'test-role', 'candidates', 'resumes', 'C-20260414-001.md');
    expect(fs.existsSync(resumePath)).toBe(false);
  });

  it('removes narrative directory', () => {
    setupCandidateWithData();
    store.deleteCandidate('test-role', 'C-20260414-001');
    const narrativeDir = path.join(tmpDir, 'roles', 'test-role', 'candidates', 'C-20260414-001');
    expect(fs.existsSync(narrativeDir)).toBe(false);
  });

  it('removes conversation directory', () => {
    setupCandidateWithData();
    store.deleteCandidate('test-role', 'C-20260414-001');
    const convDir = path.join(tmpDir, 'conversations', 'conv-C-20260414-001');
    expect(fs.existsSync(convDir)).toBe(false);
  });

  it('writes an audit entry for the deletion', () => {
    setupCandidateWithData();
    store.deleteCandidate('test-role', 'C-20260414-001');
    const auditPath = path.join(tmpDir, 'audit.jsonl');
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
    const deleteEntry = lines.map(l => JSON.parse(l)).find(e => e.action === 'delete_candidate');
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry.details.candidate_id).toBe('C-20260414-001');
    expect(deleteEntry.details.role).toBe('test-role');
  });

  it('does not remove audit.jsonl', () => {
    setupCandidateWithData();
    store.deleteCandidate('test-role', 'C-20260414-001');
    const auditPath = path.join(tmpDir, 'audit.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
  });

  it('throws CandidateNotFoundError for unknown candidate', () => {
    expect(() => store.deleteCandidate('test-role', 'C-20260414-999')).toThrow(CandidateNotFoundError);
  });

  it('does not affect other candidates', () => {
    setupCandidateWithData('C-20260414-001', 'conv-001');
    const other = makeCandidate({ candidate_id: 'C-20260414-002', conversation_id: 'conv-002' });
    store.writeCandidate('test-role', other);

    store.deleteCandidate('test-role', 'C-20260414-001');

    expect(() => store.readCandidate('test-role', 'C-20260414-002')).not.toThrow();
  });

  it('does not delete outside conversations directory when candidate conversation_id is corrupted', () => {
    const outsideDir = path.join(tmpDir, 'outside-target');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'keep.txt'), 'keep');
    const candidate = makeCandidate({
      candidate_id: 'C-20260414-001',
      conversation_id: '../outside-target',
    });
    store.writeCandidate('test-role', candidate);

    store.deleteCandidate('test-role', 'C-20260414-001');

    expect(fs.existsSync(outsideDir)).toBe(true);
    expect(fs.existsSync(path.join(outsideDir, 'keep.txt'))).toBe(true);
  });

  it('does not delete outside roles directory when role is path-traversal string', () => {
    const outsideDir = path.join(tmpDir, 'outside');
    const outsideCandidatesDir = path.join(outsideDir, 'candidates');
    fs.mkdirSync(outsideCandidatesDir, { recursive: true });
    fs.writeFileSync(path.join(outsideCandidatesDir, 'C-20260414-001.json'), JSON.stringify(makeCandidate()));
    fs.writeFileSync(path.join(outsideDir, 'keep.txt'), 'keep');

    expect(() => store.deleteCandidate('../outside', 'C-20260414-001')).toThrow(/traversal|invalid|outside/i);

    expect(fs.existsSync(outsideDir)).toBe(true);
    expect(fs.existsSync(path.join(outsideDir, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(outsideCandidatesDir, 'C-20260414-001.json'))).toBe(true);
  });
});

// ── 23. deleteRole ──────────────────────────────────────────────────────────

describe('deleteRole', () => {
  function setupRoleWithData() {
    store.writeConfig(makeConfig());
    store.writeFramework('test-role', makeFramework());
    store.writeJd('test-role', 'Job description content');
    const candidate = makeCandidate({ candidate_id: 'C-20260414-001', conversation_id: 'conv-001' });
    store.writeCandidate('test-role', candidate);
    store.writeResumeMarkdown('test-role', 'C-20260414-001', '# Resume');
    store.createConversation('conv-001');
  }

  it('removes the role directory', () => {
    setupRoleWithData();
    store.deleteRole('test-role');
    const roleDir = path.join(tmpDir, 'roles', 'test-role');
    expect(fs.existsSync(roleDir)).toBe(false);
  });

  it('role no longer appears in listRoles', () => {
    setupRoleWithData();
    store.deleteRole('test-role');
    expect(store.listRoles()).not.toContain('test-role');
  });

  it('does not remove global config', () => {
    setupRoleWithData();
    store.deleteRole('test-role');
    expect(store.configExists()).toBe(true);
  });

  it('does not remove audit.jsonl', () => {
    setupRoleWithData();
    store.deleteRole('test-role');
    const auditPath = path.join(tmpDir, 'audit.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
  });

  it('writes an audit entry for the deletion', () => {
    setupRoleWithData();
    store.deleteRole('test-role');
    const auditPath = path.join(tmpDir, 'audit.jsonl');
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
    const deleteEntry = lines.map(l => JSON.parse(l)).find(e => e.action === 'delete_role');
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry.details.role).toBe('test-role');
  });

  it('does not remove other roles', () => {
    setupRoleWithData();
    store.writeFramework('other-role', makeFramework());
    store.deleteRole('test-role');
    expect(store.listRoles()).toContain('other-role');
  });

  it('throws RoleNotFoundError for unknown role', () => {
    expect(() => store.deleteRole('nonexistent-role')).toThrow(RoleNotFoundError);
  });

  it('does not delete outside roles directory when role is path-traversal string', () => {
    // Create a directory outside roles/ that must not be deleted
    const outsideDir = path.join(tmpDir, 'outside-target');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'keep.txt'), 'keep');

    // deleteRole with a traversal input must throw a validation error, not delete outside roles/
    expect(() => store.deleteRole('../outside-target')).toThrow(/traversal|invalid|outside/i);

    // The outside directory must still exist
    expect(fs.existsSync(outsideDir)).toBe(true);
    expect(fs.existsSync(path.join(outsideDir, 'keep.txt'))).toBe(true);
  });

  it('rejects nested role paths inside roles directory', () => {
    const nestedRoleDir = path.join(tmpDir, 'roles', 'nested', 'role');
    fs.mkdirSync(nestedRoleDir, { recursive: true });
    fs.writeFileSync(path.join(nestedRoleDir, 'framework.json'), JSON.stringify(makeFramework()));

    expect(() => store.deleteRole('nested/role')).toThrow(/invalid.*role/i);
    expect(fs.existsSync(nestedRoleDir)).toBe(true);
  });

  it('does not remove credentials file', () => {
    setupRoleWithData();
    store.writeCredential('agentmail_api_key', 'test-key');
    store.deleteRole('test-role');
    const creds = store.readCredentials();
    expect(creds.agentmail_api_key).toBe('test-key');
  });

  it('does not remove global conversation directories for candidates in the role', () => {
    setupRoleWithData();
    store.deleteRole('test-role');
    const convDir = path.join(tmpDir, 'conversations', 'conv-001');
    expect(fs.existsSync(convDir)).toBe(true);
  });

  it('does not remove global conversation directories for multiple candidates in the role', () => {
    setupRoleWithData();
    const c2 = makeCandidate({ candidate_id: 'C-20260414-002', conversation_id: 'conv-002' });
    store.writeCandidate('test-role', c2);
    store.createConversation('conv-002');

    store.deleteRole('test-role');

    expect(fs.existsSync(path.join(tmpDir, 'conversations', 'conv-001'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'conversations', 'conv-002'))).toBe(true);
  });
});

// ── 24. candidate_id format validation ──────────────────────────────────────

describe('candidate_id format validation', () => {
  const INVALID_IDS = ['../../etc/passwd', '../config', 'bad/id', 'C-bad', '', 'c-20260414-001'];

  for (const badId of INVALID_IDS) {
    it(`readCandidate rejects invalid candidate_id: ${JSON.stringify(badId)}`, () => {
      expect(() => store.readCandidate('test-role', badId)).toThrow(/invalid.*candidate/i);
    });

    it(`writeCandidate rejects invalid candidate_id: ${JSON.stringify(badId)}`, () => {
      const candidate = makeCandidate({ candidate_id: badId });
      expect(() => store.writeCandidate('test-role', candidate)).toThrow(/invalid.*candidate/i);
    });

    it(`deleteCandidate rejects invalid candidate_id: ${JSON.stringify(badId)}`, () => {
      expect(() => store.deleteCandidate('test-role', badId)).toThrow(/invalid.*candidate/i);
    });
  }

  it('readCandidate accepts valid candidate_id format C-YYYYMMDD-NNN', () => {
    store.writeConfig(makeConfig());
    store.writeFramework('test-role', makeFramework());
    const candidate = makeCandidate({ candidate_id: 'C-20260414-001' });
    store.writeCandidate('test-role', candidate);
    expect(() => store.readCandidate('test-role', 'C-20260414-001')).not.toThrow();
  });
});
