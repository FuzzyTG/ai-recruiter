import { CandidateState } from './models.js';
import type { Candidate, Config, OfferedSlot, TimeoutRule } from './models.js';
import type { RecruiterStore } from './store.js';
import type { RecruiterMailClient } from './emailClient.js';
import { appendSignature, candidateFacingCc, candidateFacingFrom, generateFollowupBody } from './emailComposer.js';

export interface TimeoutExecutionResult {
  candidate_id: string;
  role: string;
  action: 'auto_followup' | 'auto_transition' | 'notify_hm';
  rule_description: string;
  executed: boolean;
  skipped_reason?: string;
  details?: Record<string, unknown>;
}

function computeSlotsHash(offeredSlots: OfferedSlot[]): string {
  if (!offeredSlots || offeredSlots.length === 0) return 'no_slots';
  const sorted = [...offeredSlots].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  return sorted.map((s) => s.start).join('|');
}

export async function executeAutoFollowup(
  store: RecruiterStore,
  emailClient: RecruiterMailClient | undefined,
  role: string,
  candidate: Candidate,
  rule: TimeoutRule,
  config: Config,
): Promise<TimeoutExecutionResult> {
  // No email client → skip
  if (!emailClient) {
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

  const emailResult = await emailClient.sendEmail({
    to: candidate.channels.email,
    subject,
    text: fullBody,
    cc: candidateFacingCc(config),
  });

  // Record outbound message in conversation
  store.appendMessage(candidate.conversation_id, {
    schema_version: 1,
    message_id: emailResult.messageId,
    direction: 'outbound',
    from: candidateFacingFrom(config),
    to: [candidate.channels.email],
    cc: candidateFacingCc(config),
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

export async function executeAutoTransition(
  store: RecruiterStore,
  role: string,
  candidate: Candidate,
  rule: TimeoutRule,
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

export function executeNotifyHm(
  store: RecruiterStore,
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

export async function executeTimeouts(
  store: RecruiterStore,
  emailClient: RecruiterMailClient | undefined,
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
          result = await executeAutoFollowup(store, emailClient, t.role, t.candidate, t.rule, config);
          break;
        case 'auto_transition':
          result = await executeAutoTransition(store, t.role, t.candidate, t.rule);
          break;
        case 'notify_hm':
          result = executeNotifyHm(store, t.role, t.candidate, t.rule);
          break;
        default:
          result = {
            candidate_id: t.candidate.candidate_id,
            role: t.role,
            action: t.rule.action as TimeoutExecutionResult['action'],
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
