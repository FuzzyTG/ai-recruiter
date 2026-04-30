import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerRecruitingTools } from './toolSchemas.js';
import {
  RecruiterStore,
  SetupRequiredError,
  RoleNotFoundError,
  CandidateNotFoundError,
  IllegalTransitionError,
  ApprovalRequiredError,
  type RoleResolution,
} from './store.js';
import { RecruiterMailClient, EmailSendError } from './emailClient.js';
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
  ResearchCard,
} from './models.js';
import {
  activeCandidateMatches,
  candidateEmailCounts,
  emptyInboxSyncResult,
  terminalThreadIds,
  trySyncInboxForMatches,
  type InboxSyncResult,
} from './inboxSync.js';
import { validateResearchCards } from './researchCards.js';
import {
  appendSignature,
  candidateFacingCc,
  candidateFacingFrom,
  coordinatorIdentity,
  generateFollowupBody,
  parseEmailAddress,
  stripTrailingSignature,
} from './emailComposer.js';
import * as crypto from 'node:crypto';
import { executeTimeouts, type TimeoutExecutionResult } from './timeoutEngine.js';
import {
  candidateFrameworkVersion,
  candidateFrameworkVersions,
  frameworkVersionsAreWeightOnlyCompatible,
  normalizedComparisonScore,
} from './frameworkVersions.js';

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
// Role resolution helpers
// ---------------------------------------------------------------------------

const ROLE_LIST_CAP = 10;

function capRoleList<T>(list: T[]): { shown: T[]; truncated: number } {
  if (list.length <= ROLE_LIST_CAP) return { shown: list, truncated: 0 };
  return { shown: list.slice(0, ROLE_LIST_CAP), truncated: list.length - ROLE_LIST_CAP };
}

function roleResolutionError(res: RoleResolution): ToolResult | null {
  if (res.status === 'exact' || res.status === 'normalized') return null;
  if (res.status === 'ambiguous') {
    const { shown, truncated } = capRoleList(res.candidates);
    const names = shown.map((c) => c.display).join(', ');
    const suffix = truncated > 0 ? ` (and ${truncated} more)` : '';
    return failure(
      'role_ambiguous',
      `Multiple roles matched "${res.input}". Ask HM to pick: ${names}${suffix}`,
      {
        input: res.input,
        candidates: shown,
        truncated_candidates: truncated,
      },
    );
  }
  // not_found
  const { shown, truncated } = capRoleList(res.available);
  const names = shown.map((c) => c.display).join(', ');
  const suffix = truncated > 0 ? ` (and ${truncated} more)` : '';
  return failure(
    'role_not_found',
    `No role matches "${res.input}". Available roles: ${names}${suffix}. Use recruit_setup to create a new role.`,
    {
      input: res.input,
      available: shown,
      truncated_available: truncated,
    },
  );
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


  // ── Tool 1: recruit_setup ───────────────────────────────────────────────

  async function recruitSetup(args: {
    hm_name?: string;
    company_name?: string;
    sender_name?: string;
    coordinator_name?: string;
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

      // ── Role resolution (single-writer via store) ──
      // Determine canonical role slug + display for this call.
      let role: string = args.role;
      let roleDisplay: string = args.role;
      if (args.role) {
        const resolution = store.resolveRole(args.role);
        if (resolution.status === 'ambiguous') {
          const err = roleResolutionError(resolution);
          if (err) return err;
        }
        if (resolution.status === 'not_found') {
          // Creating a new role; canonicalize via store.
          const { canonical, collision } = store.canonicalizeForNewRole(args.role);
          if (collision) {
            return failure(
              'role_ambiguous',
              `"${args.role}" normalizes to existing role "${collision.existing_display}". Use that role or pick a different name.`,
              {
                input: args.role,
                candidates: [{ canonical: collision.existing_canonical, display: collision.existing_display }],
              },
            );
          }
          role = canonical;
          roleDisplay = args.role;
        } else if (resolution.status === 'exact' || resolution.status === 'normalized') {
          role = resolution.canonical;
          roleDisplay = resolution.display;
        }
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
        const coordinator = coordinatorIdentity(args.coordinator_name ?? args.sender_name ?? 'AI Assistant');
        if (getApiKey() && getEmailClient()) {
          const inbox = await getEmailClient()!.createInbox(
            coordinator.display_name,
            slugify(args.hm_name!),
            args.inbox_username ?? coordinator.email_local_part,
          );
          agentmail_inbox_id = inbox.inboxId;
          inbox_email = inbox.email;
        }

        const config: Config = {
          schema_version: 1,
          hm_name: args.hm_name!,
          company_name: args.company_name!,
          sender_name: coordinator.display_name,
          cc_email: args.cc_email!,
          agentmail_inbox_id,
          agentmail_inbox_email: inbox_email,
          communication: {
            coordinator,
          },
          calendar_url: args.calendar_url ?? '',
          meeting_link: args.meeting_link ?? '',
          signature_template: `—${coordinator.display_name}\n\n---\nThis interview is coordinated by an AI assistant.\nFor direct contact: ${args.cc_email}`,
          timezone: args.timezone!,
          language: args.language!,
          created_at: new Date().toISOString(),
        };
        store.writeConfig(config);
        config_created = true;
      } else {
        // Step 1b: Config update — patch provided fields on existing config
        const updatableFields = ['calendar_url', 'meeting_link', 'cc_email', 'timezone', 'language'] as const;
        const existing = store.readConfig();
        for (const field of updatableFields) {
          if (args[field] !== undefined && args[field] !== existing[field]) {
            (existing as any)[field] = args[field];
            config_updated = true;
          }
        }
        const hadAgentMailInbox = !!existing.agentmail_inbox_id;
        const coordinatorName = args.coordinator_name ?? args.sender_name;
        if (coordinatorName !== undefined) {
          const coordinator = coordinatorIdentity(coordinatorName);
          if (JSON.stringify(existing.communication?.coordinator) !== JSON.stringify(coordinator)) {
            existing.sender_name = coordinator.display_name;
            existing.communication = {
              coordinator,
            };
            existing.signature_template = `—${coordinator.display_name}\n\n---\nThis interview is coordinated by an AI assistant.\nFor direct contact: ${existing.cc_email}`;
            config_updated = true;
          }
        }
        if (!existing.agentmail_inbox_id && getApiKey() && getEmailClient()) {
          const coordinator = existing.communication?.coordinator ?? coordinatorIdentity(existing.sender_name);
          const inbox = await getEmailClient()!.createInbox(
            coordinator.display_name,
            slugify(existing.hm_name),
            args.inbox_username ?? coordinator.email_local_part,
          );
          existing.agentmail_inbox_id = inbox.inboxId;
          existing.agentmail_inbox_email = inbox.email;
          inbox_email = inbox.email;
          config_updated = true;
        }

        if (config_updated) {
          if (coordinatorName !== undefined && hadAgentMailInbox && getEmailClient()) {
            await getEmailClient()!.updateInbox(existing.agentmail_inbox_id, {
              displayName: existing.sender_name,
            });
          }

          store.writeConfig(existing);
        }
      }

      let affectedFrameworkVersion: number | undefined;
      let activeFrameworkVersionBeforeWrite: number | undefined;

      // Step 3: Framework creation/versioning
      if (args.dimensions) {
        const weightSum = args.dimensions.reduce((s, d) => s + d.weight, 0);
        if (Math.abs(weightSum - 1.0) > 0.01) {
          return failure(
            'validation_error',
            `Dimension weights must sum to ~1.0, got ${weightSum}`,
          );
        }

        let frameworkVersion = 1;
        try {
          const versions = store.listFrameworkVersions(role);
          const activeFw = store.readFramework(role);
          activeFrameworkVersionBeforeWrite = activeFw.framework_version;
          const existingDraft = [...versions].reverse().find((version) => !version.confirmed);
          frameworkVersion = existingDraft?.framework_version
            ?? (activeFw.confirmed ? store.nextFrameworkVersion(role) : activeFw.framework_version);
        } catch (e) {
          if (!(e instanceof RoleNotFoundError)) throw e;
        }

        const fw: Framework = {
          schema_version: 1,
          role,
          role_display: roleDisplay,
          dimensions: args.dimensions,
          confirmed: args.confirm === true,
          active: args.confirm === true,
          framework_version: frameworkVersion,
          created_at: new Date().toISOString(),
        };
        store.writeFramework(role, fw);
        affectedFrameworkVersion = frameworkVersion;
        framework_created = true;
        framework_confirmed = args.confirm === true;
      }

      // Step 4: JD
      if (args.jd) {
        store.writeJd(role, args.jd);
      }

      // Step 5: Confirm framework
      if (args.confirm === true && !framework_confirmed) {
        activeFrameworkVersionBeforeWrite = store.readFramework(role).framework_version;
        const versions = store.listFrameworkVersions(role);
        const fw = [...versions].reverse().find((version) => !version.confirmed)
          ?? versions[versions.length - 1];
        fw.confirmed = true;
        fw.active = true;
        if (!fw.role_display) fw.role_display = roleDisplay;
        store.writeFramework(role, fw);
        affectedFrameworkVersion = fw.framework_version;
        framework_confirmed = true;
      }

      const activeFramework = (() => {
        try { return store.readFramework(role); } catch { return null; }
      })();
      const result: Record<string, unknown> = {
        config_created,
        config_updated,
        framework_created,
        framework_confirmed,
        role_resolved: role,
        role_display: roleDisplay,
      };
      if (activeFramework) {
        result.framework_version = activeFramework.framework_version;
        result.current_framework_version = activeFramework.framework_version;
        result.active_framework_version = activeFramework.framework_version;
      }
      if (affectedFrameworkVersion !== undefined) {
        result.affected_framework_version = affectedFrameworkVersion;
      }
      if (activeFrameworkVersionBeforeWrite !== undefined) {
        result.previous_active_framework_version = activeFrameworkVersionBeforeWrite;
      }
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
      const resolution = store.resolveRole(args.role);
      const errResp = roleResolutionError(resolution);
      if (errResp) return errResp;
      const role = (resolution as Extract<RoleResolution, { canonical: string }>).canonical;
      const roleDisplay = (resolution as Extract<RoleResolution, { display: string }>).display;

      // Read framework, must be confirmed
      const framework = store.readFramework(role);
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
      const candidateId = store.generateCandidateId(role);
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
        role,
        state: CandidateState.New,
        state_updated: now,
        pending_action: 'Screen resume',
        conversation_id: conversationId,
        scores: {
          overall: weightedAvg,
          dimensions: args.scores,
          framework_version: framework.framework_version,
        },
        evaluations: [],
        offered_slots: [],
        portfolio_urls: args.portfolio_urls ?? [],
        timeline: [],
        created_at: now,
      };

      // Write candidate, resume, conversation
      store.writeCandidate(role, candidate);
      store.writeResumeMarkdown(role, candidateId, args.resume_markdown);
      store.createConversation(conversationId);

      // Transition new -> screening (no approval needed)
      store.transitionState(role, candidateId, CandidateState.Screening);

      // Transition based on score
      if (weightedAvg >= 0.6) {
        store.transitionState(
          role,
          candidateId,
          CandidateState.ScreenedPass,
        );
      } else {
        store.transitionState(
          role,
          candidateId,
          CandidateState.ScreenedReject,
        );
      }

      // Read final state
      const updatedCandidate = store.readCandidate(role, candidateId);

      return success({
        candidate_id: candidateId,
        name: args.candidate_name,
        overall_score: weightedAvg,
        state: updatedCandidate.state,
        dimensions: args.scores,
        role_resolved: role,
        role_display: roleDisplay,
        framework_version: framework.framework_version,
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
      const resolution = store.resolveRole(args.role);
      const errResp = roleResolutionError(resolution);
      if (errResp) return errResp;
      const role = (resolution as Extract<RoleResolution, { canonical: string }>).canonical;
      const roleDisplay = (resolution as Extract<RoleResolution, { display: string }>).display;

      const config = store.readConfig();
      const candidate = store.readCandidate(role, args.candidate_id);

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
        const durationMinutes = args.duration_minutes ?? 60;
        const numSlots = args.num_slots ?? 3;
        const rangeStart = new Date();
        const rangeEnd = new Date(
          rangeStart.getTime() + 14 * 24 * 60 * 60 * 1000,
        ); // 2 weeks out

        const busySlots = await calendar.parseCalendarFeed(config.calendar_url, {
          rangeStart,
          rangeEnd,
        });

        // Get already offered slots
        const offeredSlots = store.getOfferedSlots(args.role);
        const excludeSlots = offeredSlots.map((s) => ({
          start: new Date(s.start),
          end: new Date(s.end),
        }));

        // Find free slots

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
            cc: candidateFacingCc(config),
          });
          messageId = emailResult.messageId;
          threadId = emailResult.threadId;

          // Record outbound message
          const msg: ConversationMessage = {
            schema_version: 1,
            message_id: messageId,
            direction: 'outbound',
            from: candidateFacingFrom(config),
            to: [candidate.channels.email],
            cc: candidateFacingCc(config),
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
          organizerEmail: config.agentmail_inbox_email ?? config.agentmail_inbox_id,
          organizerName: config.communication?.coordinator.display_name ?? config.sender_name ?? config.hm_name,
          attendeeEmail: candidate.channels.email,
          attendeeName: candidate.name,
          uid: icsUid,
          timezone: config.timezone,
          hmEmail: config.cc_email,
          hmName: config.hm_name,
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
            cc: candidateFacingCc(config),
            attachments: [attachment],
          });
          messageId = emailResult.messageId;

          // Record outbound message
          const msg: ConversationMessage = {
            schema_version: 1,
            message_id: emailResult.messageId,
            direction: 'outbound',
            from: candidateFacingFrom(config),
            to: [candidate.channels.email],
            cc: candidateFacingCc(config),
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
              organizerEmail: config.agentmail_inbox_email ?? config.agentmail_inbox_id,
              organizerName: config.communication?.coordinator.display_name ?? config.sender_name ?? config.hm_name,
              attendeeEmail: candidate.channels.email,
              attendeeName: candidate.name,
              timezone: config.timezone,
              hmEmail: config.cc_email,
              hmName: config.hm_name,
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
            cc: candidateFacingCc(config),
            attachments: attachments.length > 0 ? attachments : undefined,
          });
          messageId = emailResult.messageId;

          // Record outbound message
          const msg: ConversationMessage = {
            schema_version: 1,
            message_id: emailResult.messageId,
            direction: 'outbound',
            from: candidateFacingFrom(config),
            to: [candidate.channels.email],
            cc: candidateFacingCc(config),
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
            cc: candidateFacingCc(config),
          });
          messageId = emailResult.messageId;

          // Record outbound message
          const msg: ConversationMessage = {
            schema_version: 1,
            message_id: emailResult.messageId,
            direction: 'outbound',
            from: candidateFacingFrom(config),
            to: [candidate.channels.email],
            cc: candidateFacingCc(config),
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
      let candidate = store.readCandidate(args.role, args.candidate_id);

      // Auto-transition interview_done → evaluating
      if (candidate.state === CandidateState.InterviewDone) {
        candidate = store.transitionState(args.role, args.candidate_id, CandidateState.Evaluating);
      }

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
        framework_version: framework.framework_version,
      };

      // Append evaluation
      candidate.evaluations.push(evaluation);

      // Recompute overall score as average of all evaluations' weighted averages
      let totalWeightedAvg = 0;
      for (const evalEntry of candidate.evaluations) {
        const evalFramework = evalEntry.framework_version === framework.framework_version
          ? framework
          : store.readFrameworkVersion(args.role, evalEntry.framework_version);
        totalWeightedAvg += validators.computeWeightedAverage(
          evalEntry.scores,
          evalFramework,
        );
      }
      const overallScore = Math.round(
        (totalWeightedAvg / candidate.evaluations.length) * 100,
      ) / 100;

      // Update candidate scores
      candidate.scores = {
        overall: overallScore,
        dimensions: args.scores,
        framework_version: framework.framework_version,
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
        framework_version: framework.framework_version,
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

      const versionNumbers = Array.from(new Set(candidates.flatMap(candidateFrameworkVersions)));
      const versionsForCompatibility = Array.from(new Set([...versionNumbers, framework.framework_version]))
        .map((version) => store.readFrameworkVersion(args.role, version));
      const activeVersionChanged = versionNumbers.length > 0 && !versionNumbers.includes(framework.framework_version);
      const mixedVersions = versionNumbers.length > 1 || activeVersionChanged;
      const weightOnlyCompatible = frameworkVersionsAreWeightOnlyCompatible(versionsForCompatibility);
      const rankingMode = !mixedVersions
        ? 'normal'
        : weightOnlyCompatible
          ? 'normalized_weight_only'
          : 'not_apples_to_apples';

      const comparison = candidates.map((c) => {
        const normalizedOverallScore = mixedVersions && weightOnlyCompatible && c.scores
          ? normalizedComparisonScore(c, framework, (role, version) => store.readFrameworkVersion(role, version))
          : null;
        const comparisonScore = rankingMode === 'not_apples_to_apples'
          ? null
          : normalizedOverallScore ?? c.scores?.overall ?? null;
        return {
          candidate_id: c.candidate_id,
          name: c.name,
          state: c.state,
          overall_score: c.scores?.overall ?? null,
          framework_version: candidateFrameworkVersion(c),
          normalized_overall_score: normalizedOverallScore,
          comparison_score: comparisonScore,
          dimensions: c.scores?.dimensions ?? null,
          evaluations_count: c.evaluations.length,
        };
      });

      if (rankingMode !== 'not_apples_to_apples') {
        comparison.sort((a, b) => (b.comparison_score ?? 0) - (a.comparison_score ?? 0));
      }

      const response: Record<string, unknown> = {
        role: args.role,
        framework_version: framework.framework_version,
        framework_dimensions: framework.dimensions.map((d) => d.name),
        ranking_mode: rankingMode,
        candidates: comparison,
        total: comparison.length,
      };
      if (mixedVersions) {
        response.comparison_warning = weightOnlyCompatible
          ? {
              type: 'mixed_versions_weight_only',
              message: 'Candidates were scored under different framework versions. Dimension identities match, so comparison_score recomputes older raw dimension scores using the active framework weights.',
              active_framework_version: framework.framework_version,
              candidate_framework_versions: versionNumbers.sort((a, b) => a - b),
            }
          : {
              type: 'mixed_versions_structural',
              message: 'Candidates were scored under structurally different framework versions. re-score older candidates before ranking; results are not apples-to-apples.',
              active_framework_version: framework.framework_version,
              candidate_framework_versions: versionNumbers.sort((a, b) => a - b),
            };
      }

      return success(response);
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
          cc: candidateFacingCc(config),
        });
        messageId = emailResult.messageId;

        // Record message
        const msg: ConversationMessage = {
          schema_version: 1,
          message_id: emailResult.messageId,
          direction: 'outbound',
          from: candidateFacingFrom(config),
          to: [candidate.channels.email],
          cc: candidateFacingCc(config),
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

  async function recruitSaveResearchCards(args: {
    role: string;
    candidate_id: string;
    approved: boolean;
    cards: ResearchCard[];
  }): Promise<ToolResult> {
    try {
      if (!args.approved) {
        return failure('approval_required', 'Research cards must be approved by the hiring manager before saving.');
      }
      const validationError = validateResearchCards(args.cards);
      if (validationError) {
        return failure('validation_error', validationError);
      }
      const cards = args.cards.map((card) => ({ ...card, use_in_scoring: 'context_only' as const }));
      store.writeResearchCards(args.role, args.candidate_id, cards);
      return success({
        role: args.role,
        candidate_id: args.candidate_id,
        saved: cards.length,
      });
    } catch (e) {
      return handleError(e);
    }
  }

  async function recruitStatus(args: {
    query_type: 'overview' | 'candidate' | 'timeouts' | 'inbox';
    role?: string;
    candidate_id?: string;
    auto_execute?: boolean;
    sync_inbox?: boolean;
  }): Promise<ToolResult> {
    try {
      const shouldSyncInbox = args.sync_inbox !== false;

      switch (args.query_type) {
        case 'overview': {
          const roles = args.role ? [args.role] : store.listRoles();
          const inboxSync = shouldSyncInbox
            ? await trySyncInboxForMatches(store, getEmailClient(), activeCandidateMatches(store, roles), {
              terminalThreadIds: terminalThreadIds(store, roles),
              fallbackEmailCounts: candidateEmailCounts(store, roles),
            })
            : emptyInboxSyncResult();
          const overview: Record<string, Record<string, Array<{ candidate_id: string; name: string; overall_score: number | null; framework_version: number | null }>>> = {};
          const frameworkVersions: Record<string, { active: number; candidate_score_versions: number[] }> = {};
          const versionWarnings: Record<string, { type: string; message: string }> = {};

          for (const role of roles) {
            const candidates = store.listCandidates(role);
            const grouped: Record<string, Array<{ candidate_id: string; name: string; overall_score: number | null; framework_version: number | null }>> = {};
            const activeFramework = store.readFramework(role);
            const candidateVersions = Array.from(new Set(candidates.flatMap(candidateFrameworkVersions)))
              .sort((a, b) => a - b);

            for (const c of candidates) {
              if (!grouped[c.state]) {
                grouped[c.state] = [];
              }
              grouped[c.state].push({
                candidate_id: c.candidate_id,
                name: c.name,
                overall_score: c.scores?.overall ?? null,
                framework_version: candidateFrameworkVersion(c),
              });
            }

            overview[role] = grouped;
            frameworkVersions[role] = {
              active: activeFramework.framework_version,
              candidate_score_versions: candidateVersions,
            };
            if (candidateVersions.some((version) => version !== activeFramework.framework_version)) {
              const versionSet = new Set([...candidateVersions, activeFramework.framework_version]);
              const versions = Array.from(versionSet).map((version) => store.readFrameworkVersion(role, version));
              const weightOnlyCompatible = frameworkVersionsAreWeightOnlyCompatible(versions);
              versionWarnings[role] = weightOnlyCompatible
                ? {
                    type: 'mixed_versions_weight_only',
                    message: 'Some candidates were scored under different framework weights with matching dimensions. Use recruit_compare to normalize comparison scores.',
                  }
                : {
                    type: 'mixed_versions_structural',
                    message: 'Some candidates were scored under structurally different framework versions. Re-score older candidates before ranking.',
                  };
            }
          }

          const config = store.configExists() ? store.readConfig() : undefined;
          return success({
            overview,
            framework_versions: frameworkVersions,
            version_warnings: versionWarnings,
            agentmail_key_configured: !!getApiKey(),
            agentmail_inbox_configured: !!config?.agentmail_inbox_id,
            inbox_sync: inboxSync,
          });
        }

        case 'candidate': {
          if (!args.role || !args.candidate_id) {
            return failure(
              'validation_error',
              'role and candidate_id are required for candidate query',
            );
          }

          const preSyncCandidate = store.readCandidate(args.role, args.candidate_id);
          const inboxSync = shouldSyncInbox
            ? await trySyncInboxForMatches(
              store,
              getEmailClient(),
              isTerminalState(preSyncCandidate.state)
                ? []
                : activeCandidateMatches(store, [args.role], args.candidate_id),
              {
                terminalThreadIds: terminalThreadIds(store, [args.role]),
                fallbackEmailCounts: candidateEmailCounts(store, [args.role]),
              },
            )
            : emptyInboxSyncResult();
          const candidate = store.readCandidate(args.role, args.candidate_id);
          const conversation = store.readConversation(candidate.conversation_id);
          const recentMessages = conversation.slice(-5);
          const narrative = store.readNarrative(args.role, args.candidate_id);
          const researchCards = store.readResearchCards(args.role, args.candidate_id);

          return success({
            candidate,
            recent_messages: recentMessages,
            narrative: narrative || null,
            research_cards: researchCards,
            inbox_sync: inboxSync,
          });
        }

        case 'timeouts': {
          const roles = args.role ? [args.role] : store.listRoles();
          const inboxSync = shouldSyncInbox
            ? await trySyncInboxForMatches(store, getEmailClient(), activeCandidateMatches(store, roles), {
              terminalThreadIds: terminalThreadIds(store, roles),
              fallbackEmailCounts: candidateEmailCounts(store, roles),
            })
            : emptyInboxSyncResult();
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
            execution_results = await executeTimeouts(store, getEmailClient(), timeouts, config);
          }

          return success({
            overdue,
            inbox_sync: inboxSync,
            ...(execution_results ? { execution_results } : {}),
          });
        }

        case 'inbox': {
          const roles = args.role ? [args.role] : store.listRoles();
          const inboxSync = await trySyncInboxForMatches(store, getEmailClient(), activeCandidateMatches(store, roles), {
            terminalThreadIds: terminalThreadIds(store, roles),
            fallbackEmailCounts: candidateEmailCounts(store, roles),
            includeUnmatched: true,
          });

          return success(inboxSync);
        }

        default:
          return failure('validation_error', `Unknown query_type: ${args.query_type}`);
      }
    } catch (e) {
      return handleError(e);
    }
  }

  // ── Tool 8: recruit_cleanup ───────────────────────────────────────────

  async function recruitCleanup(args: {
    action: 'delete_candidate' | 'delete_role';
    role: string;
    candidate_id?: string;
    confirm: boolean;
  }): Promise<ToolResult> {
    try {
      if (!args.confirm) {
        return failure(
          'approval_required',
          'Confirmation required: cleanup operations are irreversible',
        );
      }

      const resolution = store.resolveRole(args.role);
      const errResp = roleResolutionError(resolution);
      if (errResp) return errResp;
      const role = (resolution as Extract<RoleResolution, { canonical: string }>).canonical;

      if (args.action === 'delete_candidate') {
        if (!args.candidate_id) {
          return failure(
            'validation_error',
            'candidate_id is required for delete_candidate',
          );
        }

        const deletion = store.deleteCandidate(role, args.candidate_id);
        return success({
          deleted: true,
          action: args.action,
          candidate_id: args.candidate_id,
          role,
          ...(deletion.conversation_history_count > 0
            ? { warning: `Deleted candidate had conversation history (${deletion.conversation_history_count} message(s))` }
            : {}),
        });
      }

      if (args.action === 'delete_role') {
        store.deleteRole(role);
        return success({
          deleted: true,
          action: args.action,
          role,
        });
      }

      return failure('validation_error', `Unknown action: ${args.action}`);
    } catch (e) {
      return handleError(e);
    }
  }

  return {
    recruitSetup,
    recruitScore,
    recruitSchedule,
    recruitEvaluate,
    recruitCompare,
    recruitDecide,
    recruitSaveResearchCards,
    recruitStatus,
    recruitCleanup,
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
  const server = new McpServer({ name: 'ai-recruiter', version: '0.1.13' });

  registerRecruitingTools(server, handlers);

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
