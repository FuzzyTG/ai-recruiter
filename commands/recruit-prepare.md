---
name: recruit-prepare
description: Generate a candidate-specific interview prep guide
---

## Rules

- This command is **read-only**. Never modify state, send emails, or write files.
- Generate prep for **one candidate in one role** only.
- Return the prep guide directly in chat. Do not persist generated prep artifacts.
- Use existing MCP tools for all recruiting data access. Never read from `~/.recruiter/` directly.
- Saved `research_cards` are the only research context for prep; do not use web/search/profile tools or perform live research here.
- Match output language to `config.language` when available.

## Dependency Guard

**[MCP]** Call `recruit_status({ query_type: "overview", sync_inbox: false })`.

- If `setup_required` error → "No recruiting config found. Run `/recruit-setup` first."
- Otherwise → proceed.

## Protocol

### Step 1: Resolve Candidate

**[LLM]** Resolve exactly one `(role, candidate_id)` pair before fetching candidate detail.

Use overview data to match the HM's input:
- If both `role` and `candidate_id` are provided, use that pair.
- If no role is provided and exactly one overview candidate matches the supplied ID or name, use that candidate's role.
- If multiple roles or candidates match, ask the HM to choose and do not fetch candidate detail yet.
- If no matching candidate is found, say no matching candidate was found and suggest `/recruit-status`.
- If the requested role is not present in overview, say the role was not found.

### Step 2: Retrieve Candidate Context

**[MCP]** Call `recruit_status({ query_type: "candidate", role: "<role>", candidate_id: "<candidate_id>", sync_inbox: false })`.

If `role_not_found` or `candidate_not_found` is returned, show a short friendly error and do not generate prep.

Use candidate details, scores, evaluations, timeline, pending action, recent conversation history, and saved `research_cards` from the `recruit_status` candidate detail response. Do not run live web/profile research during prep. Use research cards only as context for sharper probes, preserving their fact / inference / unknown / confidence / source separation. Use role or framework context only if it is present in the status output or already available from overview/setup context. If role, JD, framework, resume/CV markdown, research cards, or notes are unavailable, state the limitation briefly and avoid inventing details.

### Step 3: Generate Interview Prep Guide

**[LLM]** Generate a concise, candidate-specific guide with these sections:

1. Candidate snapshot
2. Role-fit summary
3. Strengths to verify
4. Risks / gaps to probe
5. Candidate-specific interview questions
6. Follow-up questions based on resume claims
7. Evaluation reminders tied to the framework
8. Research-card-informed probes
9. Suggested interviewer focus

Ground recommendations in the candidate's stored data. If a data source is missing, state that briefly and avoid inventing details. Where useful, note unavailable sources inline, such as "No interview evaluation recorded yet" or "Resume text unavailable; questions are based on score evidence and conversation history."

## Output Format

```text
Interview Prep: <Candidate Name> (<candidate_id>)
Role: <role>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Candidate snapshot
...

2. Role-fit summary
...

3. Strengths to verify
...

4. Risks / gaps to probe
...

5. Candidate-specific interview questions
...

6. Follow-up questions based on resume claims
...

7. Evaluation reminders tied to the framework
...

8. Research-card-informed probes
...

9. Suggested interviewer focus
...
```

End with the relevant next-action suggestion, such as `/recruit-evaluate` after the interview.

## Anti-patterns

| Pattern | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| Creating a new MCP tool for prep | Prep is LLM synthesis, not durable server state | Use existing read-oriented MCP status data |
| Writing prep files | Prep is optional generated assistance | Return the guide directly in chat |
| Generating role-level generic guides | Issue scope is one candidate in one role | Resolve and use a specific `candidate_id` |
| Inventing resume details | Misleads interviewers | State missing context and ask candidate-specific questions from available data |
| Running live research during prep | Prep must be read-only and use saved cards only | Suggest `/recruit-research` before prep if more context is needed |
| Blending facts and inferences from research cards | Makes source confidence unclear | Preserve fact / inference / unknown / confidence / source separation |
| Changing candidate state | Prep is not a pipeline step | Suggest follow-up commands only |
