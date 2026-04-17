---
name: recruit-status
description: View pipeline overview, candidate details, or overdue timeout alerts
---

## Rules

- Modes 1-3 are **read-only**. Never modify state, send emails, or write files from those modes.
- Mode 4 (inbox sync) **writes** to conversation logs but does not modify candidate state or send emails. It is idempotent.
- If an action is needed, suggest the appropriate command (e.g., "/recruit-schedule", "/recruit-decide").
- Match output language to `config.language`.

## Dependency Guard

**[MCP]** Call `recruit_status({ query_type: "overview" })`.

- If `setup_required` error → "No recruiting config found. Run `/recruit-setup` first."
- Otherwise → proceed.

## Protocol

Determine which mode the HM wants based on their input:

### Mode 1: Pipeline Overview (default)

Triggered by: "status", "where are we", "show pipeline", or no specific candidate mentioned.

**[LLM]** Determine if HM wants a specific role or all roles.

**[MCP]** Call `recruit_status({ query_type: "overview", role?: "..." })`.

**[LLM]** Format response as a pipeline board grouped by state:

```
Pipeline: senior-pm
━━━━━━━━━━━━━━━━━━━

Screened Pass (2)
  • C-20260415-001  Alice Chen    0.82  → Schedule interview
  • C-20260415-002  Bob Wang      0.71  → Schedule interview

Scheduling (1)
  • C-20260414-003  Carol Li      0.78  → Awaiting candidate reply

Evaluating (1)
  • C-20260413-001  Dave Zhang    0.85  → Complete evaluation

Hired (1)
  • C-20260412-001  Eve Liu       0.91
```

Highlight pending actions for each candidate. Group terminal states at the bottom.

### Mode 2: Candidate Detail

Triggered by: "tell me about Alice", "show candidate C-20260415-001", or any specific candidate reference.

**[LLM]** Identify the role and candidate_id. If HM refers by name, first call overview to find the ID.

**[MCP]** Call `recruit_status({ query_type: "candidate", role: "...", candidate_id: "..." })`.

**[LLM]** Display full candidate profile:

```
Candidate: Alice Chen (C-20260415-001)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

State:    screened_pass
Email:    alice@example.com
Score:    0.82 overall

Dimensions:
  technical_depth:  4/5  "5 years PM at BigCorp, led platform migration"
  communication:    4/5  "Clear writing samples, structured resume"
  leadership:       3/5  "IC track, limited team lead experience"

Evaluations: 0 rounds
Timeline:
  2026-04-15 09:00  new → screening
  2026-04-15 09:00  screening → screened_pass

Recent Messages: (none)
Narrative: (none)
```

### Mode 3: Timeout Alerts

Triggered by: "any overdue?", "timeouts", "what needs attention", "anything stuck".

**[MCP]** Call `recruit_status({ query_type: "timeouts", role?: "..." })`.

**[LLM]** Display overdue items with urgency:

```
⚠ Overdue Items
━━━━━━━━━━━━━━━

🔴 3h overdue — Carol Li (scheduling)
   Rule: All proposed slots expired, HM decides next step
   Action: Run /recruit-schedule to resend with new slots

🟡 2h overdue — Dave Zhang (evaluating)
   Rule: Remind HM to make hiring decision (72h limit)
   Action: Run /recruit-evaluate or /recruit-decide
```

Sort by overdue_hours descending (most urgent first).

### Mode 4: Inbox Sync

Triggered by: "check inbox", "any replies?", "what did X say?", "sync messages", or cron.

**[MCP]** Call `recruit_status({ query_type: "inbox", role?: "..." })`.

This fetches inbound messages from AgentMail, matches them to known candidates by sender email, deduplicates against already-recorded messages, and syncs new messages into candidate conversation logs.

**[LLM]** Format response as a summary of new replies:

```
Inbox Sync Results
━━━━━━━━━━━━━━━━━

2 new replies synced, 1 unmatched

New Messages:
  • Alice Chen (C-20260415-001)
    Subject: Re: Interview Scheduling
    "Thanks for reaching out! I'm available on Tuesday..."
    Received: 2026-04-15 14:30 UTC

  • Bob Wang (C-20260415-002)
    Subject: Re: Interview Scheduling
    "I'd prefer the Thursday slot at 2pm..."
    Received: 2026-04-15 15:12 UTC

Unmatched:
  • unknown@example.com — "Job inquiry" (2026-04-15 13:00 UTC)
```

Suggest next action based on candidate state:
- If candidate is in `scheduling` → suggest `/recruit-schedule confirm` to lock in their preferred slot
- If candidate is in a terminal state → note the reply for HM awareness
- For unmatched messages → suggest checking if the sender is a new applicant

**Note:** Unlike Modes 1-3, inbox sync writes to conversation logs (it is idempotent — running it multiple times will not create duplicate entries).

## Output Format

Always include:
- Role name
- Candidate count per state
- Clear next-action suggestions with the relevant slash command
- Timestamps in config.timezone

## Anti-patterns

| Pattern | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| Making state changes from this command | Status is read-only | Suggest the correct command for the action |
| Querying candidate without role | MCP requires role for candidate queries | Ask for or infer the role first |
| Ignoring timeout urgency | Slots may have already expired | Highlight urgency, recommend immediate action |
| Showing raw JSON to HM | Poor UX | Format into readable tables and summaries |
