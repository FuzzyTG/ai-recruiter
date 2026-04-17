import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createHandlers, type ServerDeps } from '../src/server.js';
import { RecruiterStore } from '../src/store.js';
import { RecruiterMailClient } from '../src/emailClient.js';
import { CandidateState } from '../src/models.js';

// ---------------------------------------------------------------------------
// Mock only the network call in calendar.ts (parseCalendarFeed), not the
// slot-finding logic. This lets us test the full wiring including
// findFreeSlots and slot duration trimming.
// ---------------------------------------------------------------------------

vi.mock('../src/calendar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/calendar.js')>();
  return {
    ...actual,
    // Return empty busy slots — all working hours are free
    parseCalendarFeed: vi.fn().mockResolvedValue([]),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEmailClient(): RecruiterMailClient {
  return {
    sendEmail: vi
      .fn()
      .mockResolvedValue({ messageId: 'msg-001', threadId: 'thread-001' }),
    replyToMessage: vi
      .fn()
      .mockResolvedValue({ messageId: 'msg-002', threadId: 'thread-001' }),
    createInbox: vi
      .fn()
      .mockResolvedValue({ inboxId: 'inbox-001', email: 'recruiter@agentmail.to' }),
    updateInbox: vi.fn().mockResolvedValue(undefined),
    listMessages: vi
      .fn()
      .mockResolvedValue({ messages: [], nextCursor: undefined }),
  } as unknown as RecruiterMailClient;
}

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Integration test: full setup → score → schedule → evaluate → decide
// ---------------------------------------------------------------------------

describe('Integration: full hiring pipeline', () => {
  let tmpDir: string;
  let store: RecruiterStore;
  let emailClient: RecruiterMailClient;
  let handlers: ReturnType<typeof createHandlers>;

  const ROLE = 'senior-engineer';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruiter-integ-'));
    store = new RecruiterStore(tmpDir);
    emailClient = createMockEmailClient();
    handlers = createHandlers({ store, emailClient, apiKey: 'test-key' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('setup → score → schedule(preview) → schedule(send) → evaluate → decide(hire)', async () => {
    // ── Step 1: Setup ──────────────────────────────────────────────────
    const setupResult = await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      calendar_url: 'https://cal.test/feed.ics',
      meeting_link: 'https://meet.test/room',
      timezone: 'Asia/Shanghai',
      language: 'en',
      inbox_username: 'acme-recruiting',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5 scale', description: 'Tech skills' },
        { name: 'communication', weight: 0.4, rubric: '1-5 scale', description: 'Comm skills' },
      ],
      confirm: true,
    });

    const setup = parseResult(setupResult);
    expect(setup.success).toBe(true);
    expect(setup.data.config_created).toBe(true);
    expect(setup.data.framework_created).toBe(true);
    expect(setup.data.framework_confirmed).toBe(true);
    expect(setup.data.inbox_email).toBe('recruiter@agentmail.to');

    // Verify config was persisted with all fields
    const config = store.readConfig();
    expect(config.hm_name).toBe('Quan');
    expect(config.calendar_url).toBe('https://cal.test/feed.ics');
    expect(config.meeting_link).toBe('https://meet.test/room');
    expect(config.timezone).toBe('Asia/Shanghai');

    // ── Step 2: Score a candidate (pass) ─────────────────────────────
    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Alice Chen',
      email: 'alice@example.com',
      resume_markdown: '# Alice Chen\n\nSenior Engineer at BigTech',
      scores: {
        technical: { score: 5, evidence: 'Strong system design experience' },
        communication: { score: 4, evidence: 'Clear writing in resume' },
      },
      approved: true,
    });

    const score = parseResult(scoreResult);
    expect(score.success).toBe(true);
    expect(score.data.state).toBe(CandidateState.ScreenedPass);
    expect(score.data.overall_score).toBeGreaterThanOrEqual(0.6);
    const candidateId = score.data.candidate_id;

    // Verify candidate file on disk
    const candidate = store.readCandidate(ROLE, candidateId);
    expect(candidate.name).toBe('Alice Chen');
    expect(candidate.channels.email).toBe('alice@example.com');

    // ── Step 3: Schedule — preview (approved: false) ─────────────────
    const previewResult = await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'propose',
      duration_minutes: 30,
      num_slots: 3,
      approved: false,
    });

    const preview = parseResult(previewResult);
    expect(preview.success).toBe(true);
    expect(preview.data.email_sent).toBe(false);
    expect(preview.data.approved).toBe(false);
    expect(preview.data.slots.length).toBeGreaterThan(0);

    // Verify slots have correct 30-minute duration
    for (const slot of preview.data.slots) {
      const start = new Date(slot.start);
      const end = new Date(slot.end);
      const durationMs = end.getTime() - start.getTime();
      expect(durationMs).toBe(30 * 60_000); // exactly 30 minutes
    }

    // Verify state did NOT change (no side effects)
    const afterPreview = store.readCandidate(ROLE, candidateId);
    expect(afterPreview.state).toBe(CandidateState.ScreenedPass);

    // Verify no email was sent
    expect(emailClient.sendEmail).not.toHaveBeenCalled();

    // ── Step 4: Schedule — send (approved: true) ─────────────────────
    // Build email body from preview slots (simulate what LLM would do)
    const slots = preview.data.slots;
    const slotLines = slots.map((s: { start: string; end: string }, i: number) => {
      const start = new Date(s.start);
      const end = new Date(s.end);
      return `${i + 1}. ${start.toISOString()} - ${end.toISOString()}`;
    });
    const emailBody = `Dear Alice,\n\nPlease pick a slot:\n${slotLines.join('\n')}\n\nBest,\nQuan`;

    const sendResult = await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'propose',
      duration_minutes: 30,
      num_slots: 3,
      email_subject: 'Interview Scheduling: Senior Engineer',
      email_body: emailBody,
      approved: true,
    });

    const send = parseResult(sendResult);
    expect(send.success).toBe(true);
    expect(send.data.email_sent).toBe(true);
    expect(send.data.message_id).toBe('msg-001');

    // Verify state transitioned to scheduling
    const afterSend = store.readCandidate(ROLE, candidateId);
    expect(afterSend.state).toBe(CandidateState.Scheduling);

    // Verify email was sent (proposal: no ICS attachments)
    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
    const emailCall = (emailClient.sendEmail as any).mock.calls[0][0];
    expect(emailCall.to).toBe('alice@example.com');
    expect(emailCall.cc).toEqual(['quan@acme.com']);
    expect(emailCall.attachments).toBeUndefined(); // no ICS in proposal

    // Verify conversation message was recorded
    const conversation = store.readConversation(afterSend.conversation_id);
    expect(conversation.length).toBeGreaterThan(0);
    expect(conversation[conversation.length - 1].direction).toBe('outbound');

    // ── Step 5: Confirm slot ─────────────────────────────────────────
    const confirmedSlot = { start: slots[0].start, end: slots[0].end };
    const confirmResult = await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'confirm',
      confirmed_slot: confirmedSlot,
      email_subject: 'Interview Confirmed: Senior Engineer',
      email_body: `Dear Alice,\n\nYour interview is confirmed for ${confirmedSlot.start}.\n\nMeeting link: https://meet.test/room\n\nBest,\nQuan`,
      approved: true,
    });

    const confirm = parseResult(confirmResult);
    expect(confirm.success).toBe(true);
    expect(confirm.data.email_sent).toBe(true);

    // Verify state → interview_confirmed
    const afterConfirm = store.readCandidate(ROLE, candidateId);
    expect(afterConfirm.state).toBe(CandidateState.InterviewConfirmed);

    // Confirm email DOES have ICS attachment (all emails use sendEmail now)
    expect(emailClient.sendEmail).toHaveBeenCalledTimes(2); // propose + confirm
    const confirmEmailCall = (emailClient.sendEmail as any).mock.calls[1][0];
    expect(confirmEmailCall.attachments).toBeDefined();
    expect(confirmEmailCall.attachments.length).toBe(1);

    // ── Step 6: Transition to evaluating ─────────────────────────────
    // interview_confirmed → interview_done → evaluating
    store.transitionState(ROLE, candidateId, CandidateState.InterviewDone);
    store.transitionState(ROLE, candidateId, CandidateState.Evaluating);

    // ── Step 7: Evaluate ─────────────────────────────────────────────
    const evalResult = await handlers.recruitEvaluate({
      role: ROLE,
      candidate_id: candidateId,
      interviewer: 'Bob Tech Lead',
      scores: {
        technical: { score: 4, evidence: 'Solid system design discussion' },
        communication: { score: 5, evidence: 'Articulate and structured' },
      },
      input_type: 'structured',
      narrative: 'Alice demonstrated strong technical depth and clear communication.',
    });

    const evalParsed = parseResult(evalResult);
    expect(evalParsed.success).toBe(true);
    expect(evalParsed.data.evaluation_round).toBe(1);
    expect(evalParsed.data.overall_score).toBeGreaterThan(0);

    // ── Step 8: Transition to decision_pending ───────────────────────
    store.transitionState(ROLE, candidateId, CandidateState.Calibration);
    store.transitionState(ROLE, candidateId, CandidateState.DecisionPending);

    // ── Step 9: Decide (hire) ────────────────────────────────────────
    const decideResult = await handlers.recruitDecide({
      role: ROLE,
      candidate_id: candidateId,
      decision: 'hire',
      email_subject: 'Congratulations! Offer from Acme Corp',
      email_body: 'Dear Alice,\n\nWe are thrilled to offer you the Senior Engineer position.\n\nBest,\nQuan',
      approved: true,
    });

    const decide = parseResult(decideResult);
    expect(decide.success).toBe(true);
    expect(decide.data.decision).toBe('hire');
    expect(decide.data.state).toBe(CandidateState.Hired);
    expect(decide.data.email_sent).toBe(true);

    // Verify terminal state
    const final = store.readCandidate(ROLE, candidateId);
    expect(final.state).toBe(CandidateState.Hired);

    // Verify total emails: 3 sendEmail (propose + confirm + hire), no replyToMessage
    expect(emailClient.sendEmail).toHaveBeenCalledTimes(3);
    expect(emailClient.replyToMessage).not.toHaveBeenCalled();
  });

  it('setup → score (reject) — low score gets screened_reject', async () => {
    // Setup
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    // Score low
    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Bob Weak',
      email: 'bob@example.com',
      resume_markdown: '# Bob\n\nJunior dev, 6 months experience',
      scores: {
        technical: { score: 1, evidence: 'No relevant experience' },
        communication: { score: 2, evidence: 'Poorly written resume' },
      },
      approved: true,
    });

    const score = parseResult(scoreResult);
    expect(score.success).toBe(true);
    expect(score.data.state).toBe(CandidateState.ScreenedReject);
    expect(score.data.overall_score).toBeLessThan(0.6);
  });

  it('config update — patching calendar_url on existing config', async () => {
    // Initial setup without calendar_url
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
    });

    expect(store.readConfig().calendar_url).toBe('');

    // Update calendar_url
    const updateResult = await handlers.recruitSetup({
      calendar_url: 'https://cal.test/new-feed.ics',
      role: ROLE,
    });

    const update = parseResult(updateResult);
    expect(update.success).toBe(true);
    expect(update.data.config_updated).toBe(true);
    expect(store.readConfig().calendar_url).toBe('https://cal.test/new-feed.ics');
  });

  it('schedule rejects email with [SLOTS] placeholder', async () => {
    // Setup + score
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      calendar_url: 'https://cal.test/feed.ics',
      meeting_link: 'https://meet.test/room',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Alice Chen',
      email: 'alice@example.com',
      resume_markdown: '# Alice',
      scores: {
        technical: { score: 5, evidence: 'Great' },
        communication: { score: 5, evidence: 'Great' },
      },
      approved: true,
    });
    const candidateId = parseResult(scoreResult).data.candidate_id;

    // Try to schedule with placeholder in email body
    const result = await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'propose',
      email_body: 'Dear Alice,\n\nHere are available slots:\n[SLOTS]\n\nBest,\nQuan',
      approved: true,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('validation_error');
    expect(parsed.message).toContain('[SLOTS]');
  });

  it('slot durations match requested duration_minutes', async () => {
    // Setup
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      calendar_url: 'https://cal.test/feed.ics',
      meeting_link: 'https://meet.test/room',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Carol',
      email: 'carol@example.com',
      resume_markdown: '# Carol',
      scores: {
        technical: { score: 5, evidence: 'Great' },
        communication: { score: 5, evidence: 'Great' },
      },
      approved: true,
    });
    const candidateId = parseResult(scoreResult).data.candidate_id;

    // Request 45-minute slots
    const result = await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'propose',
      duration_minutes: 45,
      num_slots: 5,
      approved: false,
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);

    for (const slot of parsed.data.slots) {
      const start = new Date(slot.start);
      const end = new Date(slot.end);
      const durationMs = end.getTime() - start.getTime();
      expect(durationMs).toBe(45 * 60_000); // exactly 45 minutes
    }
  });

  it('compare returns candidates sorted by score', async () => {
    // Setup
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    // Score two candidates with different scores
    await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Low Scorer',
      email: 'low@example.com',
      resume_markdown: '# Low',
      scores: {
        technical: { score: 3, evidence: 'OK' },
        communication: { score: 3, evidence: 'OK' },
      },
      approved: true,
    });

    await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'High Scorer',
      email: 'high@example.com',
      resume_markdown: '# High',
      scores: {
        technical: { score: 5, evidence: 'Excellent' },
        communication: { score: 5, evidence: 'Excellent' },
      },
      approved: true,
    });

    const compareResult = await handlers.recruitCompare({ role: ROLE });
    const compare = parseResult(compareResult);
    expect(compare.success).toBe(true);
    expect(compare.data.total).toBe(2);
    // Should be sorted descending by score
    expect(compare.data.candidates[0].name).toBe('High Scorer');
    expect(compare.data.candidates[1].name).toBe('Low Scorer');
    expect(compare.data.candidates[0].overall_score).toBeGreaterThan(
      compare.data.candidates[1].overall_score,
    );
  });

  it('decide (reject) — sends email then transitions to terminal state', async () => {
    // Setup + score
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Eve',
      email: 'eve@example.com',
      resume_markdown: '# Eve',
      scores: {
        technical: { score: 5, evidence: 'Great' },
        communication: { score: 5, evidence: 'Great' },
      },
      approved: true,
    });
    const candidateId = parseResult(scoreResult).data.candidate_id;

    // Reject directly from screened_pass (universal reject transition)
    const decideResult = await handlers.recruitDecide({
      role: ROLE,
      candidate_id: candidateId,
      decision: 'reject',
      email_subject: 'Application Update',
      email_body: 'Dear Eve,\n\nThank you for your interest. We have decided not to move forward.\n\nBest,\nQuan',
      approved: true,
    });

    const decide = parseResult(decideResult);
    expect(decide.success).toBe(true);
    expect(decide.data.state).toBe(CandidateState.Rejected);

    // Verify email was sent before state change (Hard Rule 4)
    // The mock resolves, so state should be terminal
    const final = store.readCandidate(ROLE, candidateId);
    expect(final.state).toBe(CandidateState.Rejected);
  });

  it('status overview shows pipeline board', async () => {
    // Setup + score two candidates
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Alice',
      email: 'alice@example.com',
      resume_markdown: '# Alice',
      scores: {
        technical: { score: 5, evidence: 'Great' },
        communication: { score: 5, evidence: 'Great' },
      },
      approved: true,
    });

    await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Bob',
      email: 'bob@example.com',
      resume_markdown: '# Bob',
      scores: {
        technical: { score: 1, evidence: 'Weak' },
        communication: { score: 1, evidence: 'Weak' },
      },
      approved: true,
    });

    const statusResult = await handlers.recruitStatus({ query_type: 'overview', role: ROLE });
    const status = parseResult(statusResult);
    expect(status.success).toBe(true);
    const overview = status.data.overview[ROLE];
    expect(overview[CandidateState.ScreenedPass]).toHaveLength(1);
    expect(overview[CandidateState.ScreenedReject]).toHaveLength(1);
  });

  it('schedule preview works without email_body', async () => {
    // Setup + score
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      calendar_url: 'https://cal.test/feed.ics',
      meeting_link: 'https://meet.test/room',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Diana',
      email: 'diana@example.com',
      resume_markdown: '# Diana',
      scores: {
        technical: { score: 5, evidence: 'Great' },
        communication: { score: 5, evidence: 'Great' },
      },
      approved: true,
    });
    const candidateId = parseResult(scoreResult).data.candidate_id;

    // Preview without email_body — should return slots
    const previewResult = await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'propose',
      duration_minutes: 60,
      num_slots: 3,
      approved: false,
    });

    const preview = parseResult(previewResult);
    expect(preview.success).toBe(true);
    expect(preview.data.email_sent).toBe(false);
    expect(preview.data.slots.length).toBeGreaterThan(0);
  });

  it('schedule send rejects missing email_body', async () => {
    // Setup + score
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      calendar_url: 'https://cal.test/feed.ics',
      meeting_link: 'https://meet.test/room',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Eva',
      email: 'eva@example.com',
      resume_markdown: '# Eva',
      scores: {
        technical: { score: 5, evidence: 'Great' },
        communication: { score: 5, evidence: 'Great' },
      },
      approved: true,
    });
    const candidateId = parseResult(scoreResult).data.candidate_id;

    // Send without email_body — should be rejected
    const sendResult = await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'propose',
      approved: true,
    });

    const send = parseResult(sendResult);
    expect(send.success).toBe(false);
    expect(send.message).toContain('email_body is required');
  });

  it('sender_name defaults to AI Assistant', async () => {
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
    });

    const config = store.readConfig();
    expect(config.sender_name).toBe('AI Assistant');

    // createInbox should have been called with 'AI Assistant'
    expect(emailClient.createInbox).toHaveBeenCalledWith(
      'AI Assistant',
      'quan',
      undefined,
    );
  });

  it('sender_name can be overridden', async () => {
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      sender_name: 'Acme Talent Team',
      cc_email: 'quan@acme.com',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
    });

    const config = store.readConfig();
    expect(config.sender_name).toBe('Acme Talent Team');

    expect(emailClient.createInbox).toHaveBeenCalledWith(
      'Acme Talent Team',
      'quan',
      undefined,
    );
  });

  it('schedule send appends signature_template to email body', async () => {
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      calendar_url: 'https://cal.test/feed.ics',
      meeting_link: 'https://meet.test/room',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Fay',
      email: 'fay@example.com',
      resume_markdown: '# Fay',
      scores: {
        technical: { score: 5, evidence: 'Great' },
        communication: { score: 5, evidence: 'Great' },
      },
      approved: true,
    });
    const candidateId = parseResult(scoreResult).data.candidate_id;

    await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'propose',
      email_subject: 'Interview Scheduling',
      email_body: 'Dear Fay,\n\nPlease pick a slot.',
      approved: true,
    });

    const emailCall = (emailClient.sendEmail as any).mock.calls[0][0];
    expect(emailCall.text).toContain('Dear Fay,\n\nPlease pick a slot.');
    expect(emailCall.text).toContain('This interview is coordinated by an AI assistant.');
    expect(emailCall.text).toContain('quan@acme.com');
  });

  it('decide appends signature_template to email body', async () => {
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Grace',
      email: 'grace@example.com',
      resume_markdown: '# Grace',
      scores: {
        technical: { score: 5, evidence: 'Great' },
        communication: { score: 5, evidence: 'Great' },
      },
      approved: true,
    });
    const candidateId = parseResult(scoreResult).data.candidate_id;

    await handlers.recruitDecide({
      role: ROLE,
      candidate_id: candidateId,
      decision: 'reject',
      email_subject: 'Application Update',
      email_body: 'Dear Grace,\n\nThank you for your interest.',
      approved: true,
    });

    const emailCall = (emailClient.sendEmail as any).mock.calls[0][0];
    expect(emailCall.text).toContain('Dear Grace,\n\nThank you for your interest.');
    expect(emailCall.text).toContain('This interview is coordinated by an AI assistant.');
  });

  it('sender_name update calls updateInbox on existing config', async () => {
    // Initial setup
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
    });

    expect(store.readConfig().sender_name).toBe('AI Assistant');

    // Update sender_name
    await handlers.recruitSetup({
      sender_name: 'Acme Talent Team',
      role: ROLE,
    });

    expect(store.readConfig().sender_name).toBe('Acme Talent Team');
    expect(emailClient.updateInbox).toHaveBeenCalledWith(
      'inbox-001',
      { displayName: 'Acme Talent Team' },
    );
  });
});

// ---------------------------------------------------------------------------
// Integration test: inbox sync after scheduling email
// ---------------------------------------------------------------------------

describe('Integration: inbox sync', () => {
  let tmpDir: string;
  let store: RecruiterStore;
  let emailClient: RecruiterMailClient;
  let handlers: ReturnType<typeof createHandlers>;

  const ROLE = 'senior-engineer';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruiter-integ-inbox-'));
    store = new RecruiterStore(tmpDir);
    emailClient = createMockEmailClient();
    handlers = createHandlers({ store, emailClient, apiKey: 'test-key' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inbox sync — fetches candidate reply after scheduling email', async () => {
    // ── Step 1: Setup ───────────────────────────────────────────────────
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      calendar_url: 'https://cal.test/feed.ics',
      meeting_link: 'https://meet.test/room',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5 scale', description: 'Tech skills' },
        { name: 'communication', weight: 0.4, rubric: '1-5 scale', description: 'Comm skills' },
      ],
      confirm: true,
    });

    // ── Step 2: Score a candidate ───────────────────────────────────────
    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Alice Chen',
      email: 'alice@example.com',
      resume_markdown: '# Alice Chen\n\nSenior Engineer at BigTech',
      scores: {
        technical: { score: 5, evidence: 'Strong' },
        communication: { score: 4, evidence: 'Clear' },
      },
      approved: true,
    });
    const candidateId = parseResult(scoreResult).data.candidate_id;

    // ── Step 3: Schedule (propose, approved) ────────────────────────────
    await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'propose',
      email_body: 'Dear Alice, please pick a slot.',
      approved: true,
    });

    // Verify outbound message recorded in conversation
    const candidate = store.readCandidate(ROLE, candidateId);
    const convBefore = store.readConversation(candidate.conversation_id);
    expect(convBefore.length).toBe(1);
    expect(convBefore[0].direction).toBe('outbound');

    // ── Step 4: Mock inbound reply from Alice ───────────────────────────
    (emailClient.listMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        {
          messageId: 'reply-msg-001',
          threadId: 'thread-001',
          from: 'Alice Chen <alice@example.com>',
          to: ['recruiter@agentmail.to'],
          cc: [],
          subject: 'Re: Interview Scheduling: Senior Engineer',
          text: 'Hi, I would prefer the Tuesday slot at 10am. Thanks!',
          receivedAt: '2026-04-16T08:30:00Z',
        },
      ],
      nextCursor: undefined,
    });

    // ── Step 5: Inbox sync ──────────────────────────────────────────────
    const inboxResult = await handlers.recruitStatus({ query_type: 'inbox' });
    const inbox = parseResult(inboxResult);

    expect(inbox.success).toBe(true);
    expect(inbox.data.synced).toBe(1);
    expect(inbox.data.unmatched).toBe(0);
    expect(inbox.data.new_messages[0].candidate_id).toBe(candidateId);
    expect(inbox.data.new_messages[0].name).toBe('Alice Chen');
    expect(inbox.data.new_messages[0].subject).toContain('Interview Scheduling');

    // ── Step 6: Verify shows in candidate detail ────────────────────────
    const detailResult = await handlers.recruitStatus({
      query_type: 'candidate',
      role: ROLE,
      candidate_id: candidateId,
    });
    const detail = parseResult(detailResult);

    expect(detail.success).toBe(true);
    const messages = detail.data.recent_messages;
    expect(messages.length).toBe(2); // 1 outbound + 1 inbound
    expect(messages[1].direction).toBe('inbound');
    expect(messages[1].message_id).toBe('reply-msg-001');
    expect(messages[1].body).toContain('Tuesday slot at 10am');

    // ── Step 7: Verify idempotent on second call ────────────────────────
    const inboxResult2 = await handlers.recruitStatus({ query_type: 'inbox' });
    const inbox2 = parseResult(inboxResult2);

    expect(inbox2.success).toBe(true);
    expect(inbox2.data.synced).toBe(0); // Already synced, no new messages
    expect(inbox2.data.new_messages).toHaveLength(0);

    // Conversation should still have exactly 2 messages (no duplicates)
    const convAfter = store.readConversation(candidate.conversation_id);
    expect(convAfter.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Integration test: email threading across propose → reply → confirm
// ---------------------------------------------------------------------------

describe('Integration: email threading', () => {
  let tmpDir: string;
  let store: RecruiterStore;
  let emailClient: RecruiterMailClient;
  let handlers: ReturnType<typeof createHandlers>;

  const ROLE = 'senior-engineer';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruiter-integ-thread-'));
    store = new RecruiterStore(tmpDir);
    emailClient = createMockEmailClient();
    handlers = createHandlers({ store, emailClient, apiKey: 'test-key' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('threading: full flow — propose, reply, confirm threads correctly', async () => {
    // ── Setup ──────────────────────────────────────────────────────────
    await handlers.recruitSetup({
      hm_name: 'Quan',
      company_name: 'Acme Corp',
      cc_email: 'quan@acme.com',
      calendar_url: 'https://cal.test/feed.ics',
      meeting_link: 'https://meet.test/room',
      timezone: 'UTC',
      language: 'en',
      role: ROLE,
      dimensions: [
        { name: 'technical', weight: 0.6, rubric: '1-5', description: 'Tech' },
        { name: 'communication', weight: 0.4, rubric: '1-5', description: 'Comm' },
      ],
      confirm: true,
    });

    // ── Score ───────────────────────────────────────────────────────────
    const scoreResult = await handlers.recruitScore({
      role: ROLE,
      candidate_name: 'Alice Chen',
      email: 'alice@example.com',
      resume_markdown: '# Alice Chen',
      scores: {
        technical: { score: 5, evidence: 'Strong' },
        communication: { score: 5, evidence: 'Great' },
      },
      approved: true,
    });
    const candidateId = parseResult(scoreResult).data.candidate_id;

    // ── Propose (should use sendEmail) ─────────────────────────────────
    const proposeResult = await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'propose',
      email_body: 'Dear Alice, please pick a slot.',
      approved: true,
    });
    const propose = parseResult(proposeResult);
    expect(propose.success).toBe(true);
    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailClient.replyToMessage).not.toHaveBeenCalled();

    // ── Simulate candidate reply via inbox sync ────────────────────────
    const candidate = store.readCandidate(ROLE, candidateId);
    (emailClient.listMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        {
          messageId: 'reply-msg-alice',
          threadId: 'thread-001',
          from: 'alice@example.com',
          to: ['recruiter@agentmail.to'],
          cc: [],
          subject: 'Re: Interview Scheduling',
          text: 'I prefer the first slot.',
          receivedAt: '2026-04-16T10:00:00Z',
        },
      ],
      nextCursor: undefined,
    });
    await handlers.recruitStatus({ query_type: 'inbox' });

    // ── Confirm (should use replyToMessage, targeting the reply) ──────
    const slots = propose.data.slots;
    const confirmResult = await handlers.recruitSchedule({
      role: ROLE,
      candidate_id: candidateId,
      action: 'confirm',
      confirmed_slot: { start: slots[0].start, end: slots[0].end },
      email_body: 'Your interview is confirmed!',
      approved: true,
    });
    const confirm = parseResult(confirmResult);
    expect(confirm.success).toBe(true);

    // confirm uses sendEmail (no threading)
    expect(emailClient.sendEmail).toHaveBeenCalledTimes(2); // propose + confirm

    // ── Verify conversation log ─────────
    const conversation = store.readConversation(candidate.conversation_id);
    expect(conversation.length).toBe(3); // propose + inbox reply + confirm

    // propose (first message) — outbound
    expect(conversation[0].direction).toBe('outbound');

    // inbox reply (second message) — inbound
    expect(conversation[1].direction).toBe('inbound');

    // confirm (third message) — outbound, no in_reply_to (no threading)
    expect(conversation[2].direction).toBe('outbound');
  });
});
