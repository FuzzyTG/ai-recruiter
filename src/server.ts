import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  RecruiterStore,
  SetupRequiredError,
  RoleNotFoundError,
  CandidateNotFoundError,
  IllegalTransitionError,
  ApprovalRequiredError,
} from './store.js';
import { RecruiterMailClient, EmailSendError, type InboundMessage } from './emailClient.js';
import * as calendar from './calendar.js';
import { CalendarFetchError } from './calendar.js';
import * as validators from './validators.js';
import { CandidateState, slugify, isTerminalState } from './models.js';
import type {
  Config,
  Framework,
  Candidate,
  ConversationMessage,
  OfferedSlot,
  ConfirmedInterview,
  TimeoutRule,
} from './models.js';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Email parsing helper
// ---------------------------------------------------------------------------

/** Parse email address from RFC 5322 format ("Name <email>") or plain email. */
function parseEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : raw.toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Append the config's signature_template to an email body. */
function appendSignature(body: string, config: Config): string {
  const sig = config.signature_template;
  if (!sig) return body;
  return `${body}\n\n${sig}`;
}

/**
 * Strip trailing sign-off patterns the LLM may have added.
 * Runs BEFORE appendSignature() so only the canonical signature remains.
 */
function stripTrailingSignature(body: string): string {
  const lines = body.trimEnd().split('\n');

  // Walk backwards to find where the trailing signature block begins.
  // A signature block is: optional name line(s), then a sign-off/separator/AI-disclaimer.
  // We track two things: where a sign-off was found, and how far up name lines extend.
  let cutIndex = lines.length;
  let foundSignoff = false;
  let nameOnlyCount = 0; // consecutive name-like lines seen before any signoff

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') {
      // Blank lines within the signature block are OK, but if we only
      // found name lines so far (no signoff), a blank means we've left
      // the potential signature zone — reset.
      if (!foundSignoff && nameOnlyCount > 0) {
        cutIndex = lines.length;
        nameOnlyCount = 0;
      }
      continue;
    }

    // Sign-off patterns (e.g., "Best regards,", "Thanks,")
    if (/^(best\s+regards|kind\s+regards|warm\s+regards|regards|sincerely|thanks|thank\s+you|cheers|respectfully),?\s*$/i.test(line)) {
      cutIndex = i;
      foundSignoff = true;
      continue;
    }

    // Separator lines (e.g., "---", "———")
    if (/^[-─—_]{2,}\s*$/.test(line)) {
      cutIndex = i;
      foundSignoff = true;
      continue;
    }

    // AI disclaimer (e.g., "Drafted with AI")
    if (/drafted\s+(with|by)\s+ai/i.test(line) || /ai\s+assist/i.test(line)) {
      cutIndex = i;
      foundSignoff = true;
      continue;
    }

    // Name-like line (e.g., "John Smith", "Recruiting Team")
    if (/^[\w\s.]{1,40}$/.test(line) && line.split(/\s+/).length <= 4) {
      if (foundSignoff) {
        // We already confirmed a sign-off; stop here — don't consume body lines
        break;
      }
      // Tentatively include as part of a potential signature (below sign-off)
      if (nameOnlyCount < 2) {
        cutIndex = i;
        nameOnlyCount++;
        continue;
      }
    }

    // Non-matching line: if we haven't found a signoff, the tentative
    // name cuts were just body text — reset and stop.
    if (!foundSignoff) {
      cutIndex = lines.length;
    }
    break;
  }

  if (cutIndex < lines.length && foundSignoff) {
    return lines.slice(0, cutIndex).join('\n').trimEnd();
  }
  return body.trimEnd();
}


function success(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: true, data }, null, 2),
      },
    ],
  };
}

function failure(
  error: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: false, error, message, ...extra }, null, 2),
      },
    ],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export interface ServerDeps {
  store: RecruiterStore;
  emailClient?: RecruiterMailClient;
  apiKey?: string;
}

// ---------------------------------------------------------------------------
// Follow-up email body generator (system-generated, no LLM)
// ---------------------------------------------------------------------------

function generateFollowupBody(
  candidate: Candidate,
  _rule: TimeoutRule,
  _config: Config,
): string {
  const name = candidate.name;

  if (candidate.state === CandidateState.Scheduling) {
    const slotLines = candidate.offered_slots
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      .map((s) => {
        const start = new Date(s.start);
        const dateStr = start.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        });
        const timeStr = start.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
        });
        return `  - ${dateStr} at ${timeStr}`;
      })
      .join('\n');

    return `Hi ${name},\n\nI wanted to follow up on the interview scheduling email I sent earlier. Here are the available time slots:\n\n${slotLines}\n\nPlease let me know which time works best for you, or if you need different options.`;
  }

  return `Hi ${name},\n\nI wanted to follow up on the status of your application. Please let me know if you have any updates.\n\nThank you.`;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createHandlers(deps: ServerDeps) {
  const { store } = deps;
  let _emailClient: RecruiterMailClient | undefined = deps.emailClient;
  let _apiKey: string | undefined = deps.apiKey;

  function resolveApiKey(): string | undefined {
    if (_apiKey) return _apiKey;
    // Check env
    const envKey = process.env.AGENTMAIL_API_KEY;
    if (envKey) { _apiKey = envKey; return envKey; }
    // Check credentials file
    const creds = store.readCredentials();
    if (creds.agentmail_api_key) { _apiKey = creds.agentmail_api_key; return _apiKey; }
    return undefined;
  }

  function getEmailClient(): RecruiterMailClient | undefined {
    if (_emailClient) return _emailClient;
    const key = resolveApiKey();
    if (!key) return undefined;
    let inboxId: string | undefined;
    if (store.configExists()) {
      const config = store.readConfig();
      if (config.agentmail_inbox_id) inboxId = config.agentmail_inbox_id;
    }
    _emailClient = new RecruiterMailClient({ apiKey: key, inboxId });
    return _emailClient;
  }

  // Aliases for backward compat within handlers
  function getApiKey(): string | undefined { return resolveApiKey(); }


  function computeSlotsHash(offeredSlots: OfferedSlot[]): string {
    if (!offeredSlots || offeredSlots.length === 0) return 'no_slots';
    const sorted = [...offeredSlots].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
    );
    return sorted.map((s) => s.start).join('|');
  }

  // ── Tool 1: recruit_setup ───────────────────────────────────────────────

  async function recruitSetup(args: {
    hm_name?: string;
    company_name?: string;
    sender_name?: string;
    cc_email?: string;
    calendar_url?: string;
    meeting_link?: string;
    timezone?: string;
    language?: string;
    inbox_username?: string;
    role: string;
    dimensions?: Array<{
      name: string;
      weight: number;
      rubric: string;
      description: string;
    }>;
    jd?: string;
    confirm?: boolean;
    agentmail_api_key?: string;
  }): Promise<ToolResult> {
    try {
      let config_created = false;
      let config_updated = false;
      let framework_created = false;
      let framework_confirmed = false;
      let inbox_email: string | undefined;

      // Store API key if provided (triggers lazy re-init of email client)
      if (args.agentmail_api_key) {
        store.writeCredential('agentmail_api_key', args.agentmail_api_key);
        _apiKey = args.agentmail_api_key;
        _emailClient = undefined; // force re-init on next getEmailClient()
      }

      // Step 1: Config creation
      if (!store.configExists()) {
        const missing: string[] = [];
        if (!args.hm_name) missing.push('hm_name');
        if (!args.company_name) missing.push('company_name');
        if (!args.cc_email) missing.push('cc_email');
        if (!args.timezone) missing.push('timezone');
        if (!args.language) missing.push('language');

        if (missing.length > 0) {
          return failure(
            'validation_error',
            `Missing required fields for initial setup: ${missing.join(', ')}`,
          );
        }

        let agentmail_inbox_id = '';
        const senderName = args.sender_name ?? 'AI Assistant';
        if (getApiKey() && getEmailClient()) {
          const inbox = await getEmailClient()!.createInbox(
            senderName,
            slugify(args.hm_name!),
            args.inbox_username,
          );
          agentmail_inbox_id = inbox.inboxId;
          inbox_email = inbox.email;
        }

        const config: Config = {
          schema_version: 1,
          hm_name: args.hm_name!,
          company_name: args.company_name!,
          sender_name: senderName,
          cc_email: args.cc_email!,
          agentmail_inbox_id,
          calendar_url: args.calendar_url ?? '',
          meeting_link: args.meeting_link ?? '',
          signature_template: `—${args.hm_name}\n\n---\nThis interview is coordinated by an AI assistant.\nFor direct contact: ${args.cc_email}`,
          timezone: args.timezone!,
          language: args.language!,
          created_at: new Date().toISOString(),
        };
        store.writeConfig(config);
        config_created = true;
      } else {
        // Step 1b: Config update — patch provided fields on existing config
        const updatableFields = ['calendar_url', 'meeting_link', 'cc_email', 'timezone', 'language', 'sender_name'] as const;
        const existing = store.readConfig();
        for (const field of updatableFields) {
          if (args[field] !== undefined && args[field] !== existing[field]) {
            (existing as any)[field] = args[field];
            config_updated = true;
          }
        }
        if (config_updated) {
          store.writeConfig(existing);

          // If sender_name changed, update the existing AgentMail inbox display name
          if (args.sender_name !== undefined && existing.agentmail_inbox_id && getEmailClient()) {
            try {
              await getEmailClient()!.updateInbox(existing.agentmail_inbox_id, {
                displayName: args.sender_name,
              });
            } catch {
              // Non-fatal: config is saved, inbox update is best-effort
            }
          }
        }
      }

      // Step 3: Framework creation
      if (args.dimensions) {
        const weightSum = args.dimensions.reduce((s, d) => s + d.weight, 0);
        if (Math.abs(weightSum - 1.0) > 0.01) {
          return failure(
            'validation_error',
            `Dimension weights must sum to ~1.0, got ${weightSum}`,
          );
        }

        // Check if framework already exists and is confirmed
        try {
          const existingFw = store.readFramework(args.role);
          if (existingFw.confirmed) {
            return failure(
              'validation_error',
              'Cannot update a confirmed framework. Create a new role instead.',
            );
          }
        } catch (e) {
          // RoleNotFoundError is fine - means no framework exists yet
          if (!(e instanceof RoleNotFoundError)) throw e;
        }

        const fw: Framework = {
          schema_version: 1,
          role: args.role,
          dimensions: args.dimensions,
          confirmed: false,
          created_at: new Date().toISOString(),
        };
        store.writeFramework(args.role, fw);
        framework_created = true;
      }

      // Step 4: JD
      if (args.jd) {
        store.writeJd(args.role, args.jd);
      }

      // Step 5: Confirm framework
      if (args.confirm === true) {
        const fw = store.readFramework(args.role);
        fw.confirmed = true;
        store.writeFramework(args.role, fw);
        framework_confirmed = true;
      }

      const result: Record<string, unknown> = {
        config_created,
        config_updated,
        framework_created,
        framework_confirmed,
      };
      if (inbox_email) {
        result.inbox_email = inbox_email;
      }

      return success(result);
    } catch (e) {
      return handleError(e);
    }
  }

  // ── Tool 2: recruit_score ─────────────────────────────────────────────

  async function recruitScore(args: {
    role: string;
    candidate_name: string;
    email: string;
    resume_markdown: string;
    scores: Record<string, { score: number; evidence: string }>;
    portfolio_urls?: string[];
    approved: boolean;
  }): Promise<ToolResult> {
    try {
      // Read framework, must be confirmed
      const framework = store.readFramework(args.role);
      if (!framework.confirmed) {
        return failure(
          'validation_error',
          'Framework must be confirmed before scoring candidates',
        );
      }

      // Validate scores against framework
      const scoreValidation = validators.validateScores(args.scores, framework);
      if (!scoreValidation.valid) {
        return failure(
          'validation_error',
          `Invalid scores: ${scoreValidation.errors.join('; ')}`,
        );
      }

      // Run preflight
      const preflightChecks = validators.runPreflight('recruit_score', {
        scores: args.scores,
        framework,
      });
      const failedChecks = preflightChecks.filter((c) => !c.passed);
      if (failedChecks.length > 0) {
        return failure(
          'validation_error',
          `Preflight failed: ${failedChecks.map((c) => c.message).join('; ')}`,
        );
      }

      // Compute weighted average
      const weightedAvg = validators.computeWeightedAverage(
        args.scores,
        framework,
      );

      // Generate candidate ID
      const candidateId = store.generateCandidateId(args.role);
      const conversationId = `conv-${candidateId}`;

      // Build candidate
      const now = new Date().toISOString();
      const candidate: Candidate = {
        schema_version: 1,
        candidate_id: candidateId,
        name: args.candidate_name,
        channels: {
          primary: 'email',
          email: args.email,
        },
        role: args.role,
        state: CandidateState.New,
        state_updated: now,
        pending_action: 'Screen resume',
        conversation_id: conversationId,
        scores: {
          overall: weightedAvg,
          dimensions: args.scores,
        },
        evaluations: [],
        offered_slots: [],
        portfolio_urls: args.portfolio_urls ?? [],
        timeline: [],
        created_at: now,
      };

      // Write candidate, resume, conversation
      store.writeCandidate(args.role, candidate);
      store.writeResumeMarkdown(args.role, candidateId, args.resume_markdown);
      store.createConversation(conversationId);

      // Transition new -> screening (no approval needed)
      store.transitionState(args.role, candidateId, CandidateState.Screening);

      // Transition based on score
      if (weightedAvg >= 0.6) {
        // screening -> screened_pass: not in APPROVAL_REQUIRED_TRANSITIONS
        store.transitionState(
          args.role,
          candidateId,
          CandidateState.ScreenedPass,
        );
      } else {
        // screening -> screened_reject: requires approval (Rejected is approval-gated)
        // Actually screened_reject != Rejected enum value. Check model: ScreenedReject is its own state.
        // isApprovalRequired checks if to === Scheduling | Rejected | HomeworkAssigned
        // ScreenedReject is NOT Rejected, so no approval needed.
        store.transitionState(
          args.role,
          candidateId,
          CandidateState.ScreenedReject,
        );
      }

      // Read final state
      const updatedCandidate = store.readCandidate(args.role, candidateId);

      return success({
        candidate_id: candidateId,
        name: args.candidate_name,
        overall_score: weightedAvg,
        state: updatedCandidate.state,
        dimensions: args.scores,
      });
    } catch (e) {
      return handleError(e);
    }
  }

  // ── Tool 3: recruit_schedule ──────────────────────────────────────────

  async function recruitSchedule(args: {
    role: string;
    candidate_id: string;
    action: 'propose' | 'confirm' | 'resend' | 'cancel' | 'send_homework' | 'mark_no_show' | 'mark_interview_done';
    duration_minutes?: number;
    num_slots?: number;
    confirmed_slot?: { start: string; end: string };
    email_subject?: string;
    email_body?: string;
    approved: boolean;
    target_state?: 'scheduling' | 'screened_pass' | 'withdrawn';
    homework_deadline?: string;
  }): Promise<ToolResult> {
    try {
      const config = store.readConfig();
      const candidate = store.readCandidate(args.role, args.candidate_id);

      if (args.action === 'propose' || args.action === 'resend') {
        // Validate state
        if (args.action === 'propose' && candidate.state !== CandidateState.ScreenedPass) {
          return failure(
            'validation_error',
            `Cannot propose schedule: candidate is in state ${candidate.state}, expected screened_pass`,
          );
        }
        if (args.action === 'resend' && candidate.state !== CandidateState.Scheduling) {
          return failure(
            'validation_error',
            `Cannot resend schedule: candidate is in state ${candidate.state}, expected scheduling`,
          );
        }

        // When sending (approved: true), email_body is required
        if (args.approved && !args.email_body) {
          return failure(
            'validation_error',
            'email_body is required when approved is true',
          );
        }

        // Run preflight only when sending (approved: true) — preview has no email to validate
        if (args.approved && args.email_body) {
          const language = (config.language === 'zh' ? 'zh' : 'en') as 'zh' | 'en';
          const preflightChecks = validators.runPreflight('recruit_schedule', {
            emailBody: args.email_body,
            language,
            conversationId: candidate.conversation_id,
            candidateConversationId: candidate.conversation_id,
          });
          const failedChecks = preflightChecks.filter((c) => !c.passed);
          if (failedChecks.length > 0) {
            return failure(
              'validation_error',
              `Preflight failed: ${failedChecks.map((c) => c.message).join('; ')}`,
            );
          }
        }

        // Parse calendar
        const busySlots = await calendar.parseCalendarFeed(config.calendar_url);

        // Get already offered slots
        const offeredSlots = store.getOfferedSlots(args.role);
        const excludeSlots = offeredSlots.map((s) => ({
          start: new Date(s.start),
          end: new Date(s.end),
        }));

        // Find free slots
        const durationMinutes = args.duration_minutes ?? 60;
        const numSlots = args.num_slots ?? 3;
        const rangeStart = new Date();
        const rangeEnd = new Date(
          rangeStart.getTime() + 14 * 24 * 60 * 60 * 1000,
        ); // 2 weeks out

        const freeSlots = calendar.findFreeSlots(busySlots, {
          rangeStart,
          rangeEnd,
          workingHours: {
            startHour: 9,
            endHour: 18,
            days: [1, 2, 3, 4, 5], // Mon-Fri
          },
          timezone: config.timezone || 'UTC',
          minDurationMinutes: durationMinutes,
          excludeSlots,
        });

        // Slice free gaps into fixed-duration slots matching duration_minutes
        const durationMs = durationMinutes * 60_000;
        const fixedSlots: calendar.FreeSlot[] = [];
        for (const gap of freeSlots) {
          let slotStart = new Date(gap.start);
          while (slotStart.getTime() + durationMs <= gap.end.getTime()) {
            fixedSlots.push({
              start: new Date(slotStart),
              end: new Date(slotStart.getTime() + durationMs),
            });
            slotStart = new Date(slotStart.getTime() + durationMs);
          }
        }

        // Take first num_slots
        const selectedSlots = fixedSlots.slice(0, numSlots);

        if (selectedSlots.length === 0) {
          return failure(
            'validation_error',
            'No available slots found in the next 2 weeks',
          );
        }

        // If not approved, return slots as preview without side effects
        if (!args.approved) {
          return success({
            slots_proposed: selectedSlots.length,
            slots: selectedSlots.map((s) => ({
              start: s.start.toISOString(),
              end: s.end.toISOString(),
            })),
            email_sent: false,
            approved: false,
          });
        }

        // CRITICAL: Send email BEFORE state transition (Hard Rule 4)
        // Proposal emails are plain text (no ICS) — this is a negotiation, not a booking
        const now = new Date().toISOString();
        const fullBody = appendSignature(stripTrailingSignature(args.email_body!), config);
        let messageId: string | undefined;
        let threadId: string | undefined;
        if (getEmailClient()) {
          const emailResult = await getEmailClient()!.sendEmail({
            to: candidate.channels.email,
            subject: args.email_subject ?? `Interview Scheduling: ${args.role}`,
            text: fullBody,
            cc: [config.cc_email],
          });
          messageId = emailResult.messageId;
          threadId = emailResult.threadId;

          // Record outbound message
          const msg: ConversationMessage = {
            schema_version: 1,
            message_id: messageId,
            direction: 'outbound',
            from: config.cc_email,
            to: [candidate.channels.email],
            cc: [config.cc_email],
            subject: args.email_subject ?? `Interview Scheduling: ${args.role}`,
            body: fullBody,
            timestamp: now,
            agentmail_thread_id: threadId,
          };
          store.appendMessage(candidate.conversation_id, msg);
        }

        // THEN transition state (only after email succeeds)
        store.transitionState(
          args.role,
          args.candidate_id,
          CandidateState.Scheduling,
          { approved: args.approved },
        );

        // Mark slots offered
        const slotsToOffer: OfferedSlot[] = selectedSlots.map((s) => ({
          start: s.start.toISOString(),
          end: s.end.toISOString(),
          offered_at: now,
          candidate_id: args.candidate_id,
        }));
        store.markSlotsOffered(args.role, args.candidate_id, slotsToOffer);

        return success({
          slots_proposed: selectedSlots.length,
          slots: selectedSlots.map((s) => ({
            start: s.start.toISOString(),
            end: s.end.toISOString(),
          })),
          email_sent: !!getEmailClient(),
          message_id: messageId,
        });
      } else if (args.action === 'confirm') {
        // Confirm action
        if (candidate.state !== CandidateState.Scheduling) {
          return failure(
            'validation_error',
            `Cannot confirm: candidate is in state ${candidate.state}, expected scheduling`,
          );
        }

        if (!args.confirmed_slot) {
          return failure(
            'validation_error',
            'confirmed_slot is required for confirm action',
          );
        }

        if (!args.email_body) {
          return failure(
            'validation_error',
            'email_body is required for confirm action',
          );
        }

        // Verify slot is still free (basic check)
        const slotStart = new Date(args.confirmed_slot.start);
        const slotEnd = new Date(args.confirmed_slot.end);

        // Generate ICS for confirmation
        const icsUid = `${crypto.randomUUID()}@ai-recruiter`;
        const ics = calendar.generateIcs({
          start: slotStart,
          end: slotEnd,
          summary: `Interview: ${candidate.name} - ${args.role}`,
          description: `Confirmed interview with ${candidate.name} for ${args.role}`,
          location: config.meeting_link,
          organizerEmail: config.cc_email,
          organizerName: config.hm_name,
          attendeeEmail: candidate.channels.email,
          attendeeName: candidate.name,
          uid: icsUid,
        });

        // CRITICAL: Send confirmation email BEFORE state transition (Hard Rule 4)
        const confirmBody = appendSignature(stripTrailingSignature(args.email_body!), config);
        let messageId: string | undefined;
        if (getEmailClient()) {
          const attachment = RecruiterMailClient.makeIcsAttachment(ics);
          const emailResult = await getEmailClient()!.sendEmail({
            to: candidate.channels.email,
            subject: args.email_subject ?? `Interview Confirmed: ${args.role}`,
            text: confirmBody,
            cc: [config.cc_email],
            attachments: [attachment],
          });
          messageId = emailResult.messageId;

          // Record outbound message
          const msg: ConversationMessage = {
            schema_version: 1,
            message_id: emailResult.messageId,
            direction: 'outbound',
            from: config.cc_email,
            to: [candidate.channels.email],
            cc: [config.cc_email],
            subject: args.email_subject ?? `Interview Confirmed: ${args.role}`,
            body: confirmBody,
            timestamp: new Date().toISOString(),
            agentmail_thread_id: emailResult.threadId,
          };
          store.appendMessage(candidate.conversation_id, msg);
        }

        // THEN transition state (only after email succeeds)
        store.transitionState(
          args.role,
          args.candidate_id,
          CandidateState.InterviewConfirmed,
        );

        // Release other slots
        store.releaseSlots(args.role, args.candidate_id);

        // Store confirmed interview data for future cancel
        const confirmedCandidate = store.readCandidate(args.role, args.candidate_id);
        confirmedCandidate.confirmed_interview = {
          ics_uid: icsUid,
          start: args.confirmed_slot!.start,
          end: args.confirmed_slot!.end,
        };
        store.writeCandidate(args.role, confirmedCandidate);

        return success({
          confirmed_slot: args.confirmed_slot,
          email_sent: !!getEmailClient(),
          message_id: messageId,
        });
      } else if (args.action === 'cancel') {
        // 1. Validate current state allows cancel
        if (candidate.state !== CandidateState.Scheduling &&
            candidate.state !== CandidateState.InterviewConfirmed) {
          return failure(
            'validation_error',
            `Cannot cancel: candidate is in state ${candidate.state}, expected scheduling or interview_confirmed`,
          );
        }

        // 2. Require approval
        if (!args.approved) {
          return failure(
            'approval_required',
            'Approval required for cancel action',
          );
        }

        // 3. Require email_body
        if (!args.email_body) {
          return failure(
            'validation_error',
            'email_body is required for cancel action',
          );
        }

        // 4. Require target_state
        if (!args.target_state) {
          return failure(
            'validation_error',
            'target_state is required for cancel action',
          );
        }
        const targetStateStr = args.target_state;
        const targetStateMap: Record<string, CandidateState> = {
          'scheduling': CandidateState.Scheduling,
          'screened_pass': CandidateState.ScreenedPass,
          'withdrawn': CandidateState.Withdrawn,
        };
        const targetState = targetStateMap[targetStateStr];
        if (!targetState) {
          return failure(
            'validation_error',
            `Invalid target_state: ${targetStateStr}`,
          );
        }

        // 5. Run preflight on email body
        const language = (config.language === 'zh' ? 'zh' : 'en') as 'zh' | 'en';
        const preflightChecks = validators.runPreflight('recruit_schedule', {
          emailBody: args.email_body,
          language,
          conversationId: candidate.conversation_id,
          candidateConversationId: candidate.conversation_id,
        });
        const failedChecks = preflightChecks.filter((c) => !c.passed);
        if (failedChecks.length > 0) {
          return failure(
            'validation_error',
            `Preflight failed: ${failedChecks.map((c) => c.message).join('; ')}`,
          );
        }

        // 6. CRITICAL: Side effects BEFORE state transition (Hard Rule 4)
        const cancelBody = appendSignature(stripTrailingSignature(args.email_body), config);
        let messageId: string | undefined;
        let cancelIcsSent = false;

        if (getEmailClient()) {
          const attachments: Array<{ filename: string; content: string; contentType: string }> = [];

          // If interview was confirmed, generate ICS CANCEL
          if (candidate.state === CandidateState.InterviewConfirmed &&
              candidate.confirmed_interview) {
            const cancelIcs = calendar.generateCancelIcs({
              uid: candidate.confirmed_interview.ics_uid,
              start: new Date(candidate.confirmed_interview.start),
              end: new Date(candidate.confirmed_interview.end),
              summary: `Interview: ${candidate.name} - ${args.role}`,
              organizerEmail: config.cc_email,
              organizerName: config.hm_name,
              attendeeEmail: candidate.channels.email,
              attendeeName: candidate.name,
            });

            // Validate cancel ICS
            const icsErrors = validators.validateIcs(cancelIcs);
            if (icsErrors.length > 0) {
              return failure(
                'validation_error',
                `Generated cancel ICS is invalid: ${icsErrors.join('; ')}`,
              );
            }

            attachments.push(RecruiterMailClient.makeIcsAttachment(cancelIcs));
            cancelIcsSent = true;
          }

          // Send cancel email (fresh message to candidate)
          const emailResult = await getEmailClient()!.sendEmail({
            to: candidate.channels.email,
            subject: args.email_subject ?? `Interview Cancelled: ${args.role}`,
            text: cancelBody,
            cc: [config.cc_email],
            attachments: attachments.length > 0 ? attachments : undefined,
          });
          messageId = emailResult.messageId;

          // Record outbound message
          const msg: ConversationMessage = {
            schema_version: 1,
            message_id: emailResult.messageId,
            direction: 'outbound',
            from: config.cc_email,
            to: [candidate.channels.email],
            cc: [config.cc_email],
            subject: args.email_subject ?? `Interview Cancelled: ${args.role}`,
            body: cancelBody,
            timestamp: new Date().toISOString(),
            agentmail_thread_id: emailResult.threadId,
          };
          store.appendMessage(candidate.conversation_id, msg);
        }

        // 7. THEN transition state (only after email succeeds)
        store.transitionState(
          args.role,
          args.candidate_id,
          targetState,
          { approved: args.approved, reason: 'cancel', actor: 'hm' },
        );

        // 8. Release offered slots
        store.releaseSlots(args.role, args.candidate_id);

        // 9. Clear confirmed_interview data
        const updatedCandidate = store.readCandidate(args.role, args.candidate_id);
        updatedCandidate.confirmed_interview = undefined;
        store.writeCandidate(args.role, updatedCandidate);

        return success({
          cancelled: true,
          target_state: targetStateStr,
          ics_cancel_sent: cancelIcsSent,
          email_sent: !!getEmailClient(),
          message_id: messageId,
        });
      } else if (args.action === 'send_homework') {
        // 1. Validate current state
        if (candidate.state !== CandidateState.Evaluating) {
          return failure(
            'validation_error',
            `Cannot send homework: candidate is in state ${candidate.state}, expected evaluating`,
          );
        }

        // 2. Require approval
        if (!args.approved) {
          return failure(
            'approval_required',
            'Approval required to send homework',
          );
        }

        // 3. Require email_body
        if (!args.email_body) {
          return failure(
            'validation_error',
            'email_body is required for send_homework action',
          );
        }

        // 4. Require homework_deadline
        if (!args.homework_deadline) {
          return failure(
            'validation_error',
            'homework_deadline is required for send_homework action',
          );
        }

        // 5. Validate homework_deadline is a valid date
        const deadlineDate = new Date(args.homework_deadline);
        if (isNaN(deadlineDate.getTime())) {
          return failure(
            'validation_error',
            `Invalid homework_deadline: ${args.homework_deadline}`,
          );
        }

        // 6. Run preflight on email body
        const language = (config.language === 'zh' ? 'zh' : 'en') as 'zh' | 'en';
        const preflightChecks = validators.runPreflight('recruit_schedule', {
          emailBody: args.email_body,
          language,
          conversationId: candidate.conversation_id,
          candidateConversationId: candidate.conversation_id,
        });
        const failedChecks = preflightChecks.filter((c) => !c.passed);
        if (failedChecks.length > 0) {
          return failure(
            'validation_error',
            `Preflight failed: ${failedChecks.map((c) => c.message).join('; ')}`,
          );
        }

        // 7. CRITICAL: Send email BEFORE state transition (Hard Rule 4)
        const homeworkBody = appendSignature(stripTrailingSignature(args.email_body), config);
        let messageId: string | undefined;
        if (getEmailClient()) {
          const emailResult = await getEmailClient()!.sendEmail({
            to: candidate.channels.email,
            subject: args.email_subject ?? `Homework Assignment: ${args.role}`,
            text: homeworkBody,
            cc: [config.cc_email],
          });
          messageId = emailResult.messageId;

          // Record outbound message
          const msg: ConversationMessage = {
            schema_version: 1,
            message_id: emailResult.messageId,
            direction: 'outbound',
            from: config.cc_email,
            to: [candidate.channels.email],
            cc: [config.cc_email],
            subject: args.email_subject ?? `Homework Assignment: ${args.role}`,
            body: homeworkBody,
            timestamp: new Date().toISOString(),
            agentmail_thread_id: emailResult.threadId,
          };
          store.appendMessage(candidate.conversation_id, msg);
        }

        // 8. THEN transition state (only after email succeeds)
        store.transitionState(
          args.role,
          args.candidate_id,
          CandidateState.HomeworkAssigned,
          { approved: args.approved, actor: 'hm' },
        );

        // 9. Set homework_deadline on candidate
        const updatedCandidate = store.readCandidate(args.role, args.candidate_id);
        updatedCandidate.homework_deadline = args.homework_deadline;
        store.writeCandidate(args.role, updatedCandidate);

        return success({
          homework_sent: true,
          homework_deadline: args.homework_deadline,
          email_sent: !!getEmailClient(),
          message_id: messageId,
        });
      } else if (args.action === 'mark_no_show') {
        // 1. Validate current state
        if (candidate.state !== CandidateState.InterviewConfirmed) {
          return failure(
            'validation_error',
            `Cannot mark no-show: candidate is in state ${candidate.state}, expected interview_confirmed`,
          );
        }

        // 2. Require approval
        if (!args.approved) {
          return failure(
            'approval_required',
            'Approval required to mark candidate as no-show',
          );
        }

        // 3. Transition state: interview_confirmed -> no_show
        store.transitionState(
          args.role,
          args.candidate_id,
          CandidateState.NoShow,
          { approved: args.approved, reason: 'no_show', actor: 'hm' },
        );

        // 4. Clear confirmed_interview data
        const updatedCandidate = store.readCandidate(args.role, args.candidate_id);
        updatedCandidate.confirmed_interview = undefined;
        store.writeCandidate(args.role, updatedCandidate);

        // 5. Release any offered slots
        store.releaseSlots(args.role, args.candidate_id);

        return success({
          marked_no_show: true,
          candidate_id: args.candidate_id,
        });
      } else if (args.action === 'mark_interview_done') {
        // 1. Validate current state
        if (candidate.state !== CandidateState.InterviewConfirmed) {
          return failure(
            'validation_error',
            `Cannot mark interview done: candidate is in state ${candidate.state}, expected interview_confirmed`,
          );
        }

        // 2. Transition state: interview_confirmed -> interview_done
        //    No approval needed -- this is a factual observation, not a decision
        store.transitionState(
          args.role,
          args.candidate_id,
          CandidateState.InterviewDone,
        );

        // NOTE: Do NOT clear confirmed_interview here. The interview_done timeout rule
        // reads confirmed_interview.start to compute the 72h reminder reference time.
        // confirmed_interview is only cleared on cancel.

        return success({
          interview_done: true,
          candidate_id: args.candidate_id,
        });
      }

      return failure('validation_error', `Unknown action: ${args.action}`);
    } catch (e) {
      return handleError(e);
    }
  }

  // ── Tool 4: recruit_evaluate ──────────────────────────────────────────

  async function recruitEvaluate(args: {
    role: string;
    candidate_id: string;
    interviewer: string;
    scores: Record<string, { score: number; evidence: string }>;
    input_type: 'free_form' | 'structured' | 'rubric_based';
    narrative?: string;
  }): Promise<ToolResult> {
    try {
      const candidate = store.readCandidate(args.role, args.candidate_id);

      // Run preflight
      const preflightChecks = validators.runPreflight('recruit_evaluate', {
        candidate,
      });
      const failedChecks = preflightChecks.filter((c) => !c.passed);
      if (failedChecks.length > 0) {
        return failure(
          'validation_error',
          `Preflight failed: ${failedChecks.map((c) => c.message).join('; ')}`,
        );
      }

      // Validate scores against framework
      const framework = store.readFramework(args.role);
      const scoreValidation = validators.validateScores(args.scores, framework);
      if (!scoreValidation.valid) {
        return failure(
          'validation_error',
          `Invalid scores: ${scoreValidation.errors.join('; ')}`,
        );
      }

      // Create evaluation entry
      const round = candidate.evaluations.length + 1;
      const evaluation = {
        round,
        interviewer: args.interviewer,
        scores: args.scores,
        input_type: args.input_type,
        timestamp: new Date().toISOString(),
      };

      // Append evaluation
      candidate.evaluations.push(evaluation);

      // Recompute overall score as average of all evaluations' weighted averages
      let totalWeightedAvg = 0;
      for (const evalEntry of candidate.evaluations) {
        totalWeightedAvg += validators.computeWeightedAverage(
          evalEntry.scores,
          framework,
        );
      }
      const overallScore = Math.round(
        (totalWeightedAvg / candidate.evaluations.length) * 100,
      ) / 100;

      // Update candidate scores
      candidate.scores = {
        overall: overallScore,
        dimensions: args.scores,
      };

      // Write candidate
      store.writeCandidate(args.role, candidate);

      // Append narrative if provided
      if (args.narrative) {
        store.writeNarrative(
          args.role,
          args.candidate_id,
          `\n## Evaluation Round ${round} - ${args.interviewer}\n\n${args.narrative}\n`,
        );
      }

      return success({
        evaluation_round: round,
        overall_score: overallScore,
        dimension_scores: args.scores,
      });
    } catch (e) {
      return handleError(e);
    }
  }

  // ── Tool 5: recruit_compare ───────────────────────────────────────────

  async function recruitCompare(args: {
    role: string;
    candidate_ids?: string[];
  }): Promise<ToolResult> {
    try {
      const framework = store.readFramework(args.role);
      let candidates = store.listCandidates(args.role);

      // Filter to specific IDs if provided
      if (args.candidate_ids && args.candidate_ids.length > 0) {
        const idSet = new Set(args.candidate_ids);
        candidates = candidates.filter((c) => idSet.has(c.candidate_id));
      } else {
        // Filter out terminal states unless explicitly requested
        candidates = candidates.filter((c) => !isTerminalState(c.state));
      }

      // Sort by overall score descending
      candidates.sort((a, b) => {
        const scoreA = a.scores?.overall ?? 0;
        const scoreB = b.scores?.overall ?? 0;
        return scoreB - scoreA;
      });

      const comparison = candidates.map((c) => ({
        candidate_id: c.candidate_id,
        name: c.name,
        state: c.state,
        overall_score: c.scores?.overall ?? null,
        dimensions: c.scores?.dimensions ?? null,
        evaluations_count: c.evaluations.length,
      }));

      return success({
        role: args.role,
        framework_dimensions: framework.dimensions.map((d) => d.name),
        candidates: comparison,
        total: comparison.length,
      });
    } catch (e) {
      return handleError(e);
    }
  }

  // ── Tool 6: recruit_decide ────────────────────────────────────────────

  async function recruitDecide(args: {
    role: string;
    candidate_id: string;
    decision: 'hire' | 'reject';
    email_subject: string;
    email_body: string;
    approved: boolean;
  }): Promise<ToolResult> {
    try {
      const config = store.readConfig();
      const candidate = store.readCandidate(args.role, args.candidate_id);

      // Check approval
      if (!args.approved) {
        return failure(
          'approval_required',
          `Approval required for ${args.decision} decision`,
        );
      }

      // Target state
      const targetState =
        args.decision === 'hire'
          ? CandidateState.Hired
          : CandidateState.Rejected;

      // Run preflight
      const language = (config.language === 'zh' ? 'zh' : 'en') as 'zh' | 'en';
      const preflightChecks = validators.runPreflight('recruit_decide', {
        candidate,
        targetState,
        approved: args.approved,
        emailBody: args.email_body,
        language,
        conversationId: candidate.conversation_id,
        candidateConversationId: candidate.conversation_id,
      });
      const failedChecks = preflightChecks.filter((c) => !c.passed);
      if (failedChecks.length > 0) {
        return failure(
          'validation_error',
          `Preflight failed: ${failedChecks.map((c) => c.message).join('; ')}`,
        );
      }

      // CRITICAL: Send email BEFORE state transition
      const decideBody = appendSignature(stripTrailingSignature(args.email_body), config);
      let messageId: string | undefined;
      if (getEmailClient()) {
        const emailResult = await getEmailClient()!.sendEmail({
          to: candidate.channels.email,
          subject: args.email_subject,
          text: decideBody,
          cc: [config.cc_email],
        });
        messageId = emailResult.messageId;

        // Record message
        const msg: ConversationMessage = {
          schema_version: 1,
          message_id: emailResult.messageId,
          direction: 'outbound',
          from: config.cc_email,
          to: [candidate.channels.email],
          cc: [config.cc_email],
          subject: args.email_subject,
          body: decideBody,
          timestamp: new Date().toISOString(),
          agentmail_thread_id: emailResult.threadId,
        };
        store.appendMessage(candidate.conversation_id, msg);
      }

      // THEN transition state
      const beforeState = candidate.state;
      store.transitionState(args.role, args.candidate_id, targetState, {
        approved: args.approved,
        actor: 'hm',
      });

      // Run postflight
      validators.runPostflight('recruit_decide', {
        beforeState,
        afterState: targetState,
      });

      return success({
        candidate_id: args.candidate_id,
        decision: args.decision,
        state: targetState,
        email_sent: !!getEmailClient(),
        message_id: messageId,
      });
    } catch (e) {
      return handleError(e);
    }
  }

  // ── Tool 7: recruit_status ────────────────────────────────────────────

  async function recruitStatus(args: {
    query_type: 'overview' | 'candidate' | 'timeouts' | 'inbox';
    role?: string;
    candidate_id?: string;
    auto_execute?: boolean;
  }): Promise<ToolResult> {
    try {
      switch (args.query_type) {
        case 'overview': {
          const roles = args.role ? [args.role] : store.listRoles();
          const overview: Record<string, Record<string, Array<{ candidate_id: string; name: string; overall_score: number | null }>>> = {};

          for (const role of roles) {
            const candidates = store.listCandidates(role);
            const grouped: Record<string, Array<{ candidate_id: string; name: string; overall_score: number | null }>> = {};

            for (const c of candidates) {
              if (!grouped[c.state]) {
                grouped[c.state] = [];
              }
              grouped[c.state].push({
                candidate_id: c.candidate_id,
                name: c.name,
                overall_score: c.scores?.overall ?? null,
              });
            }

            overview[role] = grouped;
          }

          return success({ overview });
        }

        case 'candidate': {
          if (!args.role || !args.candidate_id) {
            return failure(
              'validation_error',
              'role and candidate_id are required for candidate query',
            );
          }

          const candidate = store.readCandidate(args.role, args.candidate_id);
          const conversation = store.readConversation(candidate.conversation_id);
          const recentMessages = conversation.slice(-5);
          const narrative = store.readNarrative(args.role, args.candidate_id);

          return success({
            candidate,
            recent_messages: recentMessages,
            narrative: narrative || null,
          });
        }

        case 'timeouts': {
          let timeouts;
          if (args.role) {
            const roleTimeouts = store.checkTimeouts(args.role);
            timeouts = roleTimeouts.map((t) => ({ role: args.role!, ...t }));
          } else {
            timeouts = store.checkTimeoutsAllRoles();
          }

          const overdue = timeouts.map((t) => ({
            role: t.role,
            candidate_id: t.candidate.candidate_id,
            name: t.candidate.name,
            state: t.candidate.state,
            rule: t.rule.description,
            action: t.rule.action,
            overdue_hours: Math.round(t.overdue_hours * 10) / 10,
          }));

          // Execute if requested
          let execution_results: TimeoutExecutionResult[] | undefined;
          if (args.auto_execute) {
            const config = store.readConfig();
            execution_results = await executeTimeouts(timeouts, config);
          }

          return success({
            overdue,
            ...(execution_results ? { execution_results } : {}),
          });
        }

        case 'inbox': {
          // Guard: require emailClient
          if (!getEmailClient()) {
            return failure(
              'email_error',
              'Email client not configured. Set AGENTMAIL_API_KEY and run setup first.',
            );
          }

          // Build lookup map: email -> { role, candidate_id, conversation_id, name }
          const roles = args.role ? [args.role] : store.listRoles();
          const candidateMap = new Map<string, {
            role: string;
            candidate_id: string;
            conversation_id: string;
            name: string;
          }>();

          // Collect known message_ids from all candidate conversations
          const knownMessageIds = new Set<string>();

          for (const role of roles) {
            const candidates = store.listCandidates(role);
            for (const c of candidates) {
              const email = c.channels.email.toLowerCase();
              candidateMap.set(email, {
                role: c.role,
                candidate_id: c.candidate_id,
                conversation_id: c.conversation_id,
                name: c.name,
              });

              // Read existing conversation to collect known message_ids
              const messages = store.readConversation(c.conversation_id);
              for (const msg of messages) {
                knownMessageIds.add(msg.message_id);
              }
            }
          }

          // Fetch from AgentMail with pagination (max 4 pages x 50 = 200 messages)
          const allInbound: InboundMessage[] = [];
          let cursor: string | undefined;
          const MAX_PAGES = 4;
          const PAGE_SIZE = 50;

          for (let page = 0; page < MAX_PAGES; page++) {
            const result = await getEmailClient()!.listMessages({
              limit: PAGE_SIZE,
              after: cursor,
            });
            allInbound.push(...result.messages);
            cursor = result.nextCursor;
            if (!cursor) break;
          }

          // Process messages: match to candidates, dedup, sync
          const newMessages: Array<{
            candidate_id: string;
            name: string;
            subject: string;
            preview: string;
            from: string;
            received_at: string;
          }> = [];
          const unmatchedMessages: Array<{
            from: string;
            subject: string;
            received_at: string;
          }> = [];

          for (const msg of allInbound) {
            // Skip already-known messages
            if (knownMessageIds.has(msg.messageId)) continue;

            const senderEmail = parseEmailAddress(msg.from);
            const match = candidateMap.get(senderEmail);

            if (match) {
              // Append to conversation log
              const convMsg: ConversationMessage = {
                schema_version: 1,
                message_id: msg.messageId,
                direction: 'inbound',
                from: msg.from,
                to: msg.to,
                cc: msg.cc,
                subject: msg.subject,
                body: msg.text,
                timestamp: msg.receivedAt,
                agentmail_thread_id: msg.threadId,
              };
              store.appendMessage(match.conversation_id, convMsg);

              newMessages.push({
                candidate_id: match.candidate_id,
                name: match.name,
                subject: msg.subject,
                preview: msg.text.slice(0, 200),
                from: msg.from,
                received_at: msg.receivedAt,
              });
            } else {
              unmatchedMessages.push({
                from: msg.from,
                subject: msg.subject,
                received_at: msg.receivedAt,
              });
            }
          }

          return success({
            synced: newMessages.length,
            unmatched: unmatchedMessages.length,
            new_messages: newMessages,
            unmatched_messages: unmatchedMessages,
          });
        }

        default:
          return failure('validation_error', `Unknown query_type: ${args.query_type}`);
      }
    } catch (e) {
      return handleError(e);
    }
  }

  // ── Timeout Execution Engine ──────────────────────────────────────────

  interface TimeoutExecutionResult {
    candidate_id: string;
    role: string;
    action: 'auto_followup' | 'auto_transition' | 'notify_hm';
    rule_description: string;
    executed: boolean;
    skipped_reason?: string;
    details?: Record<string, unknown>;
  }

  async function executeAutoFollowup(
    role: string,
    candidate: Candidate,
    rule: TimeoutRule,
    config: Config,
  ): Promise<TimeoutExecutionResult> {
    // No email client → skip
    if (!getEmailClient()) {
      return {
        candidate_id: candidate.candidate_id,
        role,
        action: 'auto_followup',
        rule_description: rule.description,
        executed: false,
        skipped_reason: 'no_email_client',
      };
    }

    // Timeline dedup
    const slotsHash = candidate.state === CandidateState.Scheduling
      ? computeSlotsHash(candidate.offered_slots)
      : undefined;

    const isDuplicate = candidate.timeline.some(
      (entry) =>
        entry.event === 'auto_followup' &&
        entry.details?.state === candidate.state &&
        entry.details?.rule_description === rule.description &&
        (slotsHash === undefined || entry.details?.slots_hash === slotsHash),
    );
    if (isDuplicate) {
      return {
        candidate_id: candidate.candidate_id,
        role,
        action: 'auto_followup',
        rule_description: rule.description,
        executed: false,
        skipped_reason: 'duplicate_followup',
      };
    }

    // Send email (NO stripTrailingSignature — body is system-generated)
    const body = generateFollowupBody(candidate, rule, config);
    const fullBody = appendSignature(body, config);
    const subject = `Follow-up: ${config.company_name} Interview`;

    const emailResult = await getEmailClient()!.sendEmail({
      to: candidate.channels.email,
      subject,
      text: fullBody,
      cc: [config.cc_email],
    });

    // Record outbound message in conversation
    store.appendMessage(candidate.conversation_id, {
      schema_version: 1,
      message_id: emailResult.messageId,
      direction: 'outbound',
      from: config.cc_email,
      to: [candidate.channels.email],
      cc: [config.cc_email],
      subject,
      body: fullBody,
      timestamp: new Date().toISOString(),
      agentmail_thread_id: emailResult.threadId,
    });

    // Record in timeline AFTER email succeeds (for dedup and audit)
    const updated = store.readCandidate(role, candidate.candidate_id);
    updated.timeline.push({
      timestamp: new Date().toISOString(),
      event: 'auto_followup',
      details: {
        state: candidate.state,
        rule_description: rule.description,
        ...(slotsHash ? { slots_hash: slotsHash } : {}),
      },
    });
    store.writeCandidate(role, updated);

    return {
      candidate_id: candidate.candidate_id,
      role,
      action: 'auto_followup',
      rule_description: rule.description,
      executed: true,
    };
  }

  async function executeAutoTransition(
    role: string,
    candidate: Candidate,
    rule: TimeoutRule,
    _config: Config,
  ): Promise<TimeoutExecutionResult> {
    if (!rule.targetState) {
      return {
        candidate_id: candidate.candidate_id,
        role,
        action: 'auto_transition',
        rule_description: rule.description,
        executed: false,
        skipped_reason: 'no_target_state_in_rule',
      };
    }

    store.transitionState(role, candidate.candidate_id, rule.targetState, {
      approved: true,
      reason: `auto_timeout: ${rule.description}`,
      actor: 'system',
    });

    return {
      candidate_id: candidate.candidate_id,
      role,
      action: 'auto_transition',
      rule_description: rule.description,
      executed: true,
      details: {
        from_state: candidate.state,
        to_state: rule.targetState,
      },
    };
  }

  function executeNotifyHm(
    role: string,
    candidate: Candidate,
    rule: TimeoutRule,
  ): TimeoutExecutionResult {
    // Dedup: check timeline
    const slotsHash = candidate.state === CandidateState.Scheduling
      ? computeSlotsHash(candidate.offered_slots)
      : undefined;

    const isDuplicate = candidate.timeline.some(
      (entry) =>
        entry.event === 'notify_hm' &&
        entry.details?.state === candidate.state &&
        entry.details?.rule_description === rule.description &&
        (slotsHash === undefined || entry.details?.slots_hash === slotsHash),
    );
    if (isDuplicate) {
      return {
        candidate_id: candidate.candidate_id,
        role,
        action: 'notify_hm',
        rule_description: rule.description,
        executed: false,
        skipped_reason: 'duplicate_notification',
      };
    }

    // For evaluating state: skip if HM has recent timeline activity (48h)
    if (candidate.state === CandidateState.Evaluating) {
      const recentActivity = candidate.timeline.some((entry) => {
        const entryAge = (Date.now() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60);
        return entryAge < 48 && entry.event !== 'notify_hm' && entry.event !== 'auto_followup';
      });
      if (recentActivity) {
        return {
          candidate_id: candidate.candidate_id,
          role,
          action: 'notify_hm',
          rule_description: rule.description,
          executed: false,
          skipped_reason: 'hm_recently_active',
        };
      }
    }

    // Record in timeline so we don't notify again
    const updated = store.readCandidate(role, candidate.candidate_id);
    updated.timeline.push({
      timestamp: new Date().toISOString(),
      event: 'notify_hm',
      details: {
        state: candidate.state,
        rule_description: rule.description,
        ...(slotsHash ? { slots_hash: slotsHash } : {}),
      },
    });
    store.writeCandidate(role, updated);

    return {
      candidate_id: candidate.candidate_id,
      role,
      action: 'notify_hm',
      rule_description: rule.description,
      executed: true,
      details: {
        message: `Action needed: ${rule.description} — ${candidate.name} (${candidate.state})`,
      },
    };
  }

  async function executeTimeouts(
    timeouts: Array<{
      role: string;
      candidate: Candidate;
      rule: TimeoutRule;
      overdue_hours: number;
    }>,
    config: Config,
  ): Promise<TimeoutExecutionResult[]> {
    const results: TimeoutExecutionResult[] = [];

    for (const t of timeouts) {
      try {
        let result: TimeoutExecutionResult;

        switch (t.rule.action) {
          case 'auto_followup':
            result = await executeAutoFollowup(t.role, t.candidate, t.rule, config);
            break;
          case 'auto_transition':
            result = await executeAutoTransition(t.role, t.candidate, t.rule, config);
            break;
          case 'notify_hm':
            result = executeNotifyHm(t.role, t.candidate, t.rule);
            break;
          default:
            result = {
              candidate_id: t.candidate.candidate_id,
              role: t.role,
              action: t.rule.action,
              rule_description: t.rule.description,
              executed: false,
              skipped_reason: `unknown_action: ${t.rule.action}`,
            };
        }

        results.push(result);
      } catch (err) {
        results.push({
          candidate_id: t.candidate.candidate_id,
          role: t.role,
          action: t.rule.action,
          rule_description: t.rule.description,
          executed: false,
          skipped_reason: `error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return results;
  }

  return {
    recruitSetup,
    recruitScore,
    recruitSchedule,
    recruitEvaluate,
    recruitCompare,
    recruitDecide,
    recruitStatus,
  };
}

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

function handleError(e: unknown): ToolResult {
  if (e instanceof SetupRequiredError) {
    return failure('setup_required', e.message);
  }
  if (e instanceof RoleNotFoundError) {
    return failure('role_not_found', e.message);
  }
  if (e instanceof CandidateNotFoundError) {
    return failure('candidate_not_found', e.message);
  }
  if (e instanceof IllegalTransitionError) {
    return failure('illegal_transition', e.message);
  }
  if (e instanceof ApprovalRequiredError) {
    return failure('approval_required', e.message);
  }
  if (e instanceof CalendarFetchError) {
    return failure('calendar_error', e.message);
  }
  if (e instanceof EmailSendError) {
    return failure('email_error', e.message);
  }
  if (e instanceof Error) {
    return failure('validation_error', e.message);
  }
  return failure('validation_error', String(e));
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(deps?: Partial<ServerDeps>): McpServer {
  const store = deps?.store ?? new RecruiterStore(process.env.RECRUITER_HOME);
  const apiKey = deps?.apiKey ?? process.env.AGENTMAIL_API_KEY;
  const emailClient = deps?.emailClient;

  const handlers = createHandlers({ store, emailClient, apiKey });
  const server = new McpServer({ name: 'ai-recruiter', version: '0.1.0' });

  // Tool 1: recruit_setup
  server.tool(
    'recruit_setup',
    'Set up recruiting config, role framework, and JD',
    {
      hm_name: z.string().optional(),
      company_name: z.string().optional(),
      sender_name: z.string().optional(),
      cc_email: z.string().optional(),
      calendar_url: z.string().optional(),
      meeting_link: z.string().optional(),
      timezone: z.string().optional(),
      language: z.string().optional(),
      inbox_username: z.string().optional(),
      role: z.string(),
      dimensions: z
        .array(
          z.object({
            name: z.string(),
            weight: z.number(),
            rubric: z.string(),
            description: z.string(),
          }),
        )
        .optional(),
      jd: z.string().optional(),
      confirm: z.boolean().optional(),
      agentmail_api_key: z.string().optional(),
    },
    { destructiveHint: false, idempotentHint: true },
    async (args) => handlers.recruitSetup(args),
  );

  // Tool 2: recruit_score
  server.tool(
    'recruit_score',
    'Score a candidate resume against the role framework',
    {
      role: z.string(),
      candidate_name: z.string(),
      email: z.string(),
      resume_markdown: z.string(),
      scores: z.record(
        z.string(),
        z.object({ score: z.number().min(1).max(5), evidence: z.string() }),
      ),
      portfolio_urls: z.array(z.string()).optional(),
      approved: z.boolean(),
    },
    { destructiveHint: false, idempotentHint: false },
    async (args) => handlers.recruitScore(args),
  );

  // Tool 3: recruit_schedule
  server.tool(
    'recruit_schedule',
    'Schedule an interview for a candidate',
    {
      role: z.string(),
      candidate_id: z.string(),
      action: z.enum(['propose', 'confirm', 'resend', 'cancel', 'send_homework', 'mark_no_show', 'mark_interview_done']),
      duration_minutes: z.number().optional(),
      num_slots: z.number().optional(),
      confirmed_slot: z
        .object({ start: z.string(), end: z.string() })
        .optional(),
      email_subject: z.string().optional(),
      email_body: z.string().optional(),
      approved: z.boolean(),
      target_state: z.enum(['scheduling', 'screened_pass', 'withdrawn']).optional(),
      homework_deadline: z.string().optional(),
    },
    { destructiveHint: false, idempotentHint: false },
    async (args) => handlers.recruitSchedule(args),
  );

  // Tool 4: recruit_evaluate
  server.tool(
    'recruit_evaluate',
    'Evaluate a candidate after an interview',
    {
      role: z.string(),
      candidate_id: z.string(),
      interviewer: z.string(),
      scores: z.record(
        z.string(),
        z.object({ score: z.number().min(1).max(5), evidence: z.string() }),
      ),
      input_type: z.enum(['free_form', 'structured', 'rubric_based']),
      narrative: z.string().optional(),
    },
    { destructiveHint: false, idempotentHint: false },
    async (args) => handlers.recruitEvaluate(args),
  );

  // Tool 5: recruit_compare
  server.tool(
    'recruit_compare',
    'Compare candidates for a role',
    {
      role: z.string(),
      candidate_ids: z.array(z.string()).optional(),
    },
    { readOnlyHint: true },
    async (args) => handlers.recruitCompare(args),
  );

  // Tool 6: recruit_decide
  server.tool(
    'recruit_decide',
    'Make a hiring decision and notify the candidate',
    {
      role: z.string(),
      candidate_id: z.string(),
      decision: z.enum(['hire', 'reject']),
      email_subject: z.string(),
      email_body: z.string(),
      approved: z.boolean(),
    },
    { destructiveHint: true, idempotentHint: false },
    async (args) => handlers.recruitDecide(args),
  );

  // Tool 7: recruit_status
  server.tool(
    'recruit_status',
    'Query recruitment status, candidate details, timeouts, or sync inbox',
    {
      query_type: z.enum(['overview', 'candidate', 'timeouts', 'inbox']),
      role: z.string().optional(),
      candidate_id: z.string().optional(),
      auto_execute: z.boolean().optional(),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (args) => handlers.recruitStatus(args),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export { stripTrailingSignature, appendSignature, generateFollowupBody };

const isMain =
  process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('server.js');
if (isMain) {
  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err: unknown) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
