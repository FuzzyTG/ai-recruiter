---
name: recruit-setup
description: Set up recruiting config, evaluation framework, and job description for a role
---

## Rules

- All file I/O goes through MCP tools. Never write to `~/.recruiter/` directly.
- Never compute dimension weights yourself. Present them, let HM adjust, then let MCP validate they sum to 1.0.
- Match all output to `config.language` (zh or en). If this is first-time setup, ask HM for preferred language.

## Dependency Guard

**[MCP]** Call `recruit_status({ query_type: "overview" })`.

- If `setup_required` error → this is a fresh install. Proceed to Step 1.
- If success → config exists. Skip to Step 3 (framework creation).
- If role already has a confirmed framework → inform HM. They can create a new role or skip.

## Protocol

### Step 1: Collect Config (first-time only)

**[LLM]** Ask HM for:

| Field | Required | Example |
|-------|----------|---------|
| `hm_name` | Yes | "Alex Yuan" |
| `company_name` | Yes | "Acme Corp" |
| `cc_email` | Yes | "alex@acme.com" |
| `timezone` | Yes | "Asia/Shanghai" |
| `language` | Yes | "zh" or "en" |
| `calendar_url` | **Recommended** | iCal feed URL (.ics). Without this, `/recruit-schedule` cannot find free slots. |
| `meeting_link` | No | Zoom/Meet/Teams link |
| `inbox_username` | No | Local part for recruiting inbox (e.g., "quan-interview" → quan-interview@agentmail.to). If omitted, a random name is generated. |

Collect conversationally. Don't dump the table — ask naturally. For `calendar_url` and `meeting_link`, explain why they matter: without a calendar URL, the agent cannot find free interview slots. If HM doesn't have one yet, acknowledge and warn that `/recruit-schedule` will not work until it's added.

### Step 2: Create Config

**[MCP]** Call `recruit_setup` with config fields + `role` (include `inbox_username` if HM provided one).

Verify response: `config_created: true`. If `inbox_email` is returned, show it to HM — this is the AgentMail address for outbound recruiting emails.

### Step 3: Job Description

**[LLM]** Ask HM to describe the role or provide a JD. Accept:
- Pasted JD text
- A file path (read and extract)
- Verbal description (structure into JD markdown)

**[MCP]** Call `recruit_setup` with `jd` field.

### Step 4: Generate Evaluation Framework

**[LLM]** From the JD, propose 4-6 evaluation dimensions. Each dimension needs:

| Field | Type | Constraint |
|-------|------|------------|
| `name` | string | Short identifier (e.g., "technical_depth") |
| `weight` | number | 0-1, all weights must sum to 1.0 |
| `rubric` | string | What 1-5 means for this dimension |
| `description` | string | What this dimension measures |

Present as a table. Let HM adjust via natural language ("make technical heavier", "add a leadership dimension", "remove culture fit").

After each adjustment, recalculate weights so they sum to 1.0. Show updated table.

### Step 5: Save Framework

**[MCP]** Call `recruit_setup` with `dimensions` array.

If server returns `validation_error` (weights don't sum to 1.0), adjust and retry.

### Step 6: Confirm Framework

**Approval Gate**: Show HM the final framework table. Ask explicitly:

> "Once confirmed, this framework cannot be changed. Confirm?"

Only on explicit "yes":

**[MCP]** Call `recruit_setup` with `confirm: true`.

Verify response: `framework_confirmed: true`.

## Output Format

After completion, display:

```
Setup Complete
━━━━━━━━━━━━━
Config:    ✓ (inbox: recruiter-xxx@agentmail.to)
Role:      senior-pm
Framework: ✓ confirmed (4 dimensions)

| Dimension       | Weight | Rubric Summary          |
|-----------------|--------|-------------------------|
| technical_depth | 0.35   | Deep PM domain expertise|
| ...             | ...    | ...                     |

Next: Score candidates with /recruit-score
```

If `calendar_url` or `meeting_link` was not provided, append a warning:

```
⚠ Calendar URL not set — /recruit-schedule will not be able to find free slots.
⚠ Meeting link not set — interview confirmation emails will lack a join link.
Run /recruit-setup again to add these later.
```

## Anti-patterns

| Pattern | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| Computing weights in LLM | Arithmetic drift, won't match server | Present weights, let server validate sum |
| Confirming without explicit HM "yes" | Irreversible action | Always require unambiguous confirmation |
| Skipping JD before framework | Dimensions should trace to JD | Collect JD first, derive dimensions from it |
| Creating rubrics without 1-5 scale | Scores are 1-5 integers | Each rubric must describe what 1,3,5 mean |
| Suggesting > 8 dimensions | Dilutes signal, increases scoring burden | 4-6 dimensions is optimal |
| Skipping calendar_url without warning | Scheduling will fail silently later | Always warn HM if calendar_url is missing |
