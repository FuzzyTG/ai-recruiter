---
name: recruit-setup
description: Set up recruiting config, evaluation framework, and job description for a role
---

## Rules

- All file I/O goes through MCP tools. Never write to `~/.recruiter/` directly.
- Never compute dimension weights yourself. Present them, let HM adjust, then let MCP validate they sum to 1.0.
- Match all output to `config.language` (zh or en). If this is first-time setup, ask HM for preferred language.
- **Role resolution is silent on success.** When the MCP returns `role_resolved` / `role_display`, use the canonical slug without asking HM to confirm. Only prompt HM if the response is `role_ambiguous` (ask them to pick) or `role_not_found` (show available roles).

## Dependency Guard

**[MCP]** Call `recruit_status({ query_type: "overview" })`.

- If `setup_required` error → this is a fresh install. Proceed to Step 0.
- If success → config exists. Proceed to Step 0 to verify the API key is available, then go to Step 1B (show existing config and offer updates), then skip to Step 3 (framework creation).
- If role already has a confirmed framework → inform HM that any adjustment creates the next framework version under the same role, and only the latest confirmed version is active. Do not recommend creating `role-v2` as the default path. Still check Step 0 for API key.

## Protocol

### Step 0: AgentMail API Key Check

**[LLM]** Call `recruit_status({ query_type: "overview" })`. Check two things: (1) whether the response indicates an inbox is configured (look for `agentmail_inbox_configured: true`), and (2) whether the response indicates the API key is available (look for `agentmail_key_configured: true`). If the inbox is configured **and** the key is configured, email is fully set up — proceed according to Dependency Guard routing (Step 1 for fresh installs, Step 3 for existing configs). If the inbox is configured but the key is missing, tell HM: "Your inbox is set up but the API key is no longer available. Please provide it again." Ask for the key and pass it as `agentmail_api_key` in the `recruit_setup` call in Step 2. If neither exists, this is a fresh install — ask HM for their AgentMail API key (get one at https://agentmail.to) and pass it as `agentmail_api_key` in Step 2. Do not store it yourself — the tool handles credential storage.

### Step 1: Collect Config (first-time only)

**[LLM]** Ask HM for:

| Field | Required | Example |
|-------|----------|---------|
| `hm_name` | Yes | "Alex Yuan" |
| `company_name` | Yes | "Acme Corp" |
| `coordinator_name` | No | "Grace". Defaults to "AI Assistant" if omitted. |
| `cc_email` | Yes | "alex@acme.com" |
| `timezone` | Yes | "Asia/Shanghai" |
| `language` | Yes | "zh" or "en" |
| `calendar_url` | **Recommended** | iCal feed URL (.ics). Without this, `/recruit-schedule` cannot find free slots. |
| `meeting_link` | No | Zoom/Meet/Teams link |
| `inbox_username` | No | Local part for recruiting inbox (e.g., "quan-interview" → quan-interview@agentmail.to). If omitted, defaults to the normalized coordinator name. |

Collect conversationally. Don't dump the table — ask naturally. For `calendar_url` and `meeting_link`, explain why they matter: without a calendar URL, the agent cannot find free interview slots. If HM doesn't have one yet, acknowledge and warn that `/recruit-schedule` will not work until it's added.

### Step 1B: Show Existing Config (returning users only)

**[LLM]** If config already exists (Dependency Guard returned success), display current values in a compact summary:

```
Current Config
━━━━━━━━━━━━━━
Name:         Quan
Company:      Microsoft
Email:        alexyuan@microsoft.com
Timezone:     Asia/Shanghai
Calendar:     ✓ set
Meeting link: ✓ set
Inbox:        magnificentpaper249@agentmail.to
```

Then ask: "Want to update any of these, or proceed to set up a new role?" If HM wants to update fields, collect only the changed values and call `recruit_setup` with those fields. Do NOT re-ask for fields the HM didn't mention. Then proceed to Step 3.

### Step 2: Create Config

**[MCP]** Call `recruit_setup` with config fields + `role` (include `coordinator_name` and `inbox_username` if HM provided them).

Verify response: `config_created: true`. If `inbox_email` is returned, show it to HM — this is the AgentMail address for outbound recruiting emails.

### Step 3: Job Description

**[LLM]** Ask HM to describe the role or provide a JD. Accept:
- Pasted JD text
- A file path (read and extract)
- Verbal description (structure into JD markdown)

**[MCP]** Call `recruit_setup` with `jd` field.

### Step 4: Generate Evaluation Framework

**[LLM]** From the JD or requested adjustment, propose 4-6 evaluation dimensions. If adjusting a confirmed framework, explain that the confirmed version remains immutable and saving the adjustment creates the next framework version for the same role. Each dimension needs:

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

> "Once confirmed, this framework version cannot be changed. Future adjustments will create a new version under the same role. Confirm?"

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
