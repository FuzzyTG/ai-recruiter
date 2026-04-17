---
name: recruit-evaluate
description: Record interview evaluation scores for a candidate
---

## Rules

- All file I/O goes through MCP tools. Never write to `~/.recruiter/` directly.
- Never compute the overall score yourself. The server recomputes across all evaluation rounds.
- Evaluations are **append-only** — each call adds a new round, never overwrites previous rounds.
- Match output language to `config.language`.

## Dependency Guard

**[MCP]** Call `recruit_status({ query_type: "candidate", role: "<role>", candidate_id: "<id>" })`.

- If `setup_required` → "Run `/recruit-setup` first."
- If `candidate_not_found` → "Candidate not found. Run `/recruit-status` to see available candidates."
- If candidate state is NOT `evaluating` → explain: "Candidate must be in `evaluating` state. Current state: [state]." Suggest the appropriate transition if applicable.

## Protocol

### Step 1: Identify Context

**[LLM]** Clarify:
- Which candidate (by name or ID)
- Who conducted the interview (interviewer name)
- How the HM wants to provide feedback

### Step 2: Determine Input Type

**[LLM]** Ask HM how they want to share feedback:

| Input Type | When to use | LLM role |
|------------|-------------|----------|
| `free_form` | HM writes narrative text, shares notes or recording summary | Extract dimension scores from narrative |
| `structured` | HM provides score per dimension directly | Validate and pass through |
| `rubric_based` | HM references the rubric and assigns scores with evidence | Validate against rubric |

### Step 3: Collect and Structure Feedback

**For `free_form`:**

**[LLM]** Read HM's narrative input. Map it to framework dimensions:
1. Read each dimension's rubric
2. Find relevant evidence in the narrative for each dimension
3. Assign a score (1-5) based on the evidence and rubric
4. Write evidence string

Present the mapping to HM for review:

```
Extracted Scores from Your Feedback
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Dimension       | Score | Evidence (from your notes)                   |
|-----------------|-------|----------------------------------------------|
| technical_depth | 4     | "Explained distributed systems trade-offs"    |
| communication   | 5     | "Very articulate, structured thinking"        |
| leadership      | 3     | "No management examples, strong IC signals"   |

Adjust any scores?
```

Let HM revise. Repeat until satisfied.

**For `structured` / `rubric_based`:**

**[LLM]** Present the framework dimensions and collect score + evidence for each:

```
Score each dimension (1-5) with evidence:

1. technical_depth (weight: 0.35)
   Rubric: 1=no relevant experience, 3=solid fundamentals, 5=deep expertise
   Score: ___  Evidence: ___

2. communication (weight: 0.25)
   ...
```

### Step 4: Optional Narrative

**[LLM]** Ask HM if they want to add a free-form narrative summary:
- Overall impression
- Red flags or standout moments
- Comparison to other candidates
- Recommendation for next steps

This is stored separately as a narrative file.

### Step 5: Submit Evaluation

**[MCP]** Call `recruit_evaluate`:
```
{
  role, candidate_id, interviewer,
  scores: { dimension_name: { score, evidence } },
  input_type: "free_form" | "structured" | "rubric_based",
  narrative: "..." (optional)
}
```

No separate approval gate — this tool records data, it does not trigger side effects.

### Step 6: Display Result

```
Evaluation Recorded
━━━━━━━━━━━━━━━━━━━
Candidate:  Alice Chen
Round:      2 (Interviewer: Bob Smith)
Input:      free_form

| Dimension       | This Round | Overall |
|-----------------|-----------|---------|
| technical_depth | 4         | 4.0     |
| communication   | 5         | 4.5     |
| leadership      | 3         | 3.0     |

Overall Score: 0.78 (was 0.82 after round 1)

Next steps: HM decides — another interview round (/recruit-schedule),
assign homework, send to calibration, or make a decision (/recruit-decide).
```

## Anti-patterns

| Pattern | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| Averaging scores yourself | Server recomputes across all rounds | Display advisory numbers, let server be authoritative |
| Evaluating candidate not in `evaluating` state | Server enforces state check via preflight | Check state via recruit_status first |
| Omitting evidence for any dimension | Breaks audit trail | Every score must cite interview observations |
| Using dimension names not in framework | Server rejects unknown dimensions | Use exact dimension names from the framework |
| Overwriting previous rounds | Evaluations are append-only | Each call adds a new round |
| Deciding hire/reject from here | Evaluation records data only | Decisions are made via /recruit-decide |
