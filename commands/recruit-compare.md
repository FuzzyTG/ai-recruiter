---
name: recruit-compare
description: Compare candidates side-by-side for a role
---

## Rules

- This is a **read-only** command. No state changes, no emails, no file writes.
- The server returns candidates pre-sorted by overall score. Do not re-sort.
- Comparison is informational. Do not recommend hire/reject here — that's `/recruit-decide`.
- Match output language to `config.language`.

## Dependency Guard

**[MCP]** Call `recruit_status({ query_type: "overview", role: "<role>" })`.

- If `setup_required` → "Run `/recruit-setup` first."
- If `role_not_found` → "Role not found. Run `/recruit-setup` to create it."
- If no candidates exist → "No candidates scored yet. Run `/recruit-score` with resumes."

## Protocol

### Step 1: Determine Scope

**[LLM]** Ask HM:
- Which role to compare
- Compare all active candidates, or specific ones? (If specific, collect names/IDs)

### Step 2: Fetch Comparison Data

**[MCP]** Call `recruit_compare`:
```
{
  role: "...",
  candidate_ids: ["..."]  // optional — omit for all active
}
```

### Step 3: Format Comparison Table

**[LLM]** Build a side-by-side comparison using `framework_dimensions` and candidate data:

```
Candidate Comparison: senior-pm
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Rank | Name        | State      | Overall | tech | comm | lead | culture |
|------|-------------|------------|---------|------|------|------|---------|
| 1    | Alice Chen  | evaluating | 0.85    | 4.5  | 4.0  | 4.0  | 3.5     |
| 2    | Dave Zhang  | evaluating | 0.78    | 4.0  | 3.5  | 4.0  | 3.0     |
| 3    | Bob Wang    | screened   | 0.71    | 3.0  | 4.0  | 3.0  | 3.5     |

Dimensions: technical_depth (0.35), communication (0.25), leadership (0.25), culture_fit (0.15)
```

### Step 4: Provide Analysis

**[LLM]** Highlight insights:
- Who stands out in which dimensions
- Gaps between resume scores and interview scores (if evaluations exist)
- Candidates with incomplete evaluations
- State distribution (who still needs interviews, who's ready for a decision)

Keep analysis factual. Present observations, not recommendations.

```
Observations:
• Alice leads overall and in technical depth. Her interview scores
  confirmed her resume assessment.
• Dave is strong in leadership but scored lower than expected in
  communication during the interview (resume: 4, interview: 3).
• Bob has not been interviewed yet — still in screened_pass.

Candidates ready for decision: Alice, Dave
Candidates still in pipeline: Bob (needs scheduling)
```

### Step 5: Suggest Next Actions

**[LLM]** Based on candidate states, suggest:
- Candidates in `screened_pass` → "Schedule with `/recruit-schedule`"
- Candidates in `evaluating` → "Record feedback with `/recruit-evaluate` or decide with `/recruit-decide`"
- Candidates in `decision_pending` → "Make decision with `/recruit-decide`"

## Anti-patterns

| Pattern | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| Re-sorting candidates | Server returns pre-sorted by overall score | Display in server's order |
| Recommending hire/reject | This is informational only | Use /recruit-decide for decisions |
| Including terminal-state candidates by default | Noise — they're done | Only include if HM explicitly asks |
| Inventing scores not in the data | Fabrication | Only show what MCP returned |
| Skipping dimension breakdown | Overall score hides dimension-level signals | Always show per-dimension scores |
