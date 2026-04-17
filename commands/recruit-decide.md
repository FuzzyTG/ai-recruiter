---
name: recruit-decide
description: Make a hiring decision (hire or reject) and notify the candidate via email
---

## Rules

- All file I/O and email sending goes through MCP tools. Never write files or send emails directly.
- **LLM composes body text only.** Do NOT include sign-offs (e.g., "Best regards,"), names, signatures, separators ("---"), or AI disclaimers in email drafts. The server appends the signature automatically via `appendSignature()`.
- **Every decision requires explicit HM approval.** Show the exact email that will be sent, get "yes", then call MCP with `approved: true`.
- The server sends the email BEFORE transitioning state (Hard Rule 4). If email fails, state remains unchanged. Do not retry silently — inform HM.
- Date-weekday in email bodies is validated by the server. If the email mentions dates, derive weekday names from ISO strings.
- Rejection emails should be professional and generic. Do NOT include specific interview feedback (legal risk).
- Match email language to `config.language`. Match output language to `config.language`.

## Dependency Guard

**[MCP]** Call `recruit_status({ query_type: "candidate", role: "<role>", candidate_id: "<id>" })`.

- If `setup_required` → "Run `/recruit-setup` first."
- If `candidate_not_found` → "Candidate not found. Run `/recruit-status` to see available candidates."
- Candidate can be in any non-terminal state for rejection (universal transition). For hire, candidate should ideally be in `decision_pending`.
- If candidate is already in a terminal state (`hired`, `rejected`, `withdrawn`, `no_show`) → "This candidate is already in a terminal state."

## Protocol

### Step 1: Confirm Intent

**[LLM]** Clarify with HM:
- Which candidate
- Decision: hire or reject
- Any specific context for the email (e.g., start date for hire, or reason for rejection — for internal record only)

### Step 2: Show Candidate Summary

**[MCP]** Call `recruit_status({ query_type: "candidate", role, candidate_id })`.

**[LLM]** Display a summary for HM review:

```
Decision: HIRE Alice Chen
━━━━━━━━━━━━━━━━━━━━━━━━━

Current State:  decision_pending
Overall Score:  0.85
Evaluations:    2 rounds
  Round 1 (Alice HM):   0.82
  Round 2 (Bob Tech):   0.88

Timeline: 12 days in pipeline
```

### Step 3: Draft Email

**[LLM]** Draft the notification email in `config.language`.

**For hire:**
- Congratulatory tone
- Next steps (onboarding, paperwork, start date if HM provides)
- HM contact info for questions

**For reject:**
- Professional, respectful tone
- Thank the candidate for their time
- Generic encouragement ("We'll keep your profile for future opportunities")
- Do NOT mention: specific scores, interview performance, comparison to other candidates, reasons for rejection

### Step 4: Approval Gate

**[LLM]** Show HM the complete email (subject + body). State clearly what will happen:

> "This will:
> 1. Send the following email to [candidate] at [email] (CC: [config.cc_email])
> 2. Mark [candidate] as [hired/rejected] (terminal state — irreversible)
>
> Approve?"

Wait for explicit "yes". If HM wants changes, revise the email and re-present.

### Step 5: Execute Decision

**[MCP]** Call `recruit_decide`:
```
{
  role, candidate_id,
  decision: "hire" | "reject",
  email_subject: "...",
  email_body: "...",
  approved: true
}
```

### Step 6: Handle Result

**On success:**
```
Decision Executed
━━━━━━━━━━━━━━━━━
Candidate:  Alice Chen
Decision:   HIRED ✓
Email:      ✓ sent to alice@example.com
State:      hired (terminal)
```

**On email failure:**
```
⚠ Email Send Failed
━━━━━━━━━━━━━━━━━━━
The notification email could not be sent.
Candidate state is UNCHANGED (still: decision_pending).
Error: [error message]

The decision was NOT recorded. Please retry or check email configuration.
```

Do NOT retry automatically. Inform HM and let them decide.

## Batch Decisions

If HM wants to decide on multiple candidates:
1. Process one candidate at a time
2. Show email draft for each, get approval for each
3. Never batch-approve multiple decisions

## Anti-patterns

| Pattern | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| Sending email without showing HM first | HM must see and approve the exact email | Always show complete email, get explicit "yes" |
| Including interview feedback in rejection | Legal risk — can be used against the company | Keep rejections generic and professional |
| Batch-approving multiple decisions | Each decision deserves individual HM attention | One at a time, each with its own approval |
| Retrying silently on email failure | State is unchanged; HM should know | Inform HM, let them decide how to proceed |
| Deciding for candidate in terminal state | Already done — state machine rejects | Check state before attempting |
| Skipping candidate summary before decision | HM may not remember the details | Always show current scores and timeline |
