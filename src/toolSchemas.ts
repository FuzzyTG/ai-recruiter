import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RESEARCH_CLAIM_TYPES } from './researchCards.js';
import type { createHandlers } from './server.js';

type Handlers = ReturnType<typeof createHandlers>;

export function registerRecruitingTools(server: McpServer, handlers: Handlers): void {
  // Tool 1: recruit_setup
  server.tool(
    'recruit_setup',
    'Set up recruiting config, role framework, and JD',
    {
      hm_name: z.string().optional(),
      company_name: z.string().optional(),
      sender_name: z.string().optional(),
      coordinator_name: z.string().optional(),
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
      candidate_name: z.string().optional(),
      email: z.string().optional(),
      resume_markdown: z.string().optional(),
      scores: z.record(
        z.string(),
        z.object({ score: z.number().min(1).max(5), evidence: z.string() }),
      ).optional(),
      portfolio_urls: z.array(z.string()).optional(),
      approved: z.boolean(),
      screening_decision: z.enum(['reject']).optional(),
      candidate_id: z.string().optional(),
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

  // Tool 7: recruit_save_research_cards
  server.tool(
    'recruit_save_research_cards',
    'Save approved candidate research cards as context-only interview prep data',
    {
      role: z.string(),
      candidate_id: z.string(),
      approved: z.boolean(),
      cards: z.array(
        z.object({
          claim: z.string(),
          claim_type: z.enum(RESEARCH_CLAIM_TYPES),
          priority_reason: z.string(),
          source_backed_facts: z.array(
            z.object({
              fact: z.string(),
              sources: z.array(
                z.object({
                  title: z.string(),
                  url: z.string().url(),
                }),
              ).min(1),
            }),
          ).min(1),
          inferences: z.array(
            z.object({
              inference: z.string(),
              confidence: z.enum(['low', 'medium', 'high']),
            }),
          ),
          unknowns: z.array(z.string()),
          attribution_limits: z.array(z.string()),
          matching_relevance: z.string(),
          follow_up_probes: z.array(z.string()),
          use_in_scoring: z.literal('context_only'),
        }),
      ).min(1).max(5),
    },
    { destructiveHint: false, idempotentHint: false },
    async (args) => handlers.recruitSaveResearchCards(args),
  );

  // Tool 8: recruit_status
  server.tool(
    'recruit_status',
    'Query recruitment status, candidate details, timeouts, or sync inbox',
    {
      query_type: z.enum(['overview', 'candidate', 'timeouts', 'inbox']),
      role: z.string().optional(),
      candidate_id: z.string().optional(),
      auto_execute: z.boolean().optional(),
      sync_inbox: z.boolean().optional(),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (args) => handlers.recruitStatus(args),
  );

  // Tool 9: recruit_cleanup
  server.tool(
    'recruit_cleanup',
    'Delete a candidate or role cleanup target. Irreversible. Requires confirm: true.',
    {
      action: z.enum(['delete_candidate', 'delete_role']),
      role: z.string(),
      candidate_id: z.string().optional(),
      confirm: z.boolean(),
    },
    { destructiveHint: true, idempotentHint: false },
    async (args) => handlers.recruitCleanup(args),
  );
}
