---
name: recruit-score
description: Score a candidate resume against the role evaluation framework
---

## Rules

- All file I/O goes through MCP tools. Never write to `~/.recruiter/` directly.
- Never compute the weighted average yourself. Pass raw dimension scores to MCP; server computes authoritatively.
- Resume conversion (PDF/DOCX/image → Markdown) is YOUR task. The MCP server only accepts clean Markdown.
- Each score needs specific evidence from the resume. "Looks good" is not evidence.
- Match output language to `config.language`.

## Dependency Guard

**[MCP]** Call `recruit_status({ query_type: "overview", role: "<role>" })`.

- If `setup_required` → "Run `/recruit-setup` first."
- If `role_not_found` → "Role not found. Run `/recruit-setup` to create it."
- Check that framework is confirmed. If not → "Framework not confirmed. Run `/recruit-setup` with `confirm: true`."

## Protocol

### Step 1: Collect Input

**[LLM]** Ask HM for:
- Candidate name
- Candidate email
- Resume (file path, pasted text, or attached file)
- Portfolio URLs (optional — websites, GitHub, LinkedIn)

### Step 2: Convert Resume to Markdown

**[LLM]** This is your responsibility, not the server's.

**PDF**:
1. Check if `pdftotext` is available: `which pdftotext`
2. If available: `pdftotext -layout <file> -` (stdout)
3. If not available: ask HM permission to install (`brew install poppler` on macOS)
4. If install declined: use multimodal vision to read the PDF
5. Structure raw text into clean Markdown

**DOCX**:
1. Check for `pandoc`: `which pandoc`
2. If available: `pandoc -f docx -t markdown <file>`
3. If not: attempt direct read or ask HM to paste text

**Image** (screenshot, scan):
1. Use multimodal vision to read and transcribe

**Plain text**: Structure directly into Markdown sections.

**Quality check**: Verify key sections present (name, experience, education). If missing, retry with a different method or ask HM to verify.

Show converted Markdown to HM before scoring.

### Step 3: Score Each Dimension

**[LLM]** Read the framework dimensions (from setup or via status). For each dimension:

1. Read the rubric (what 1-5 means for this dimension)
2. Find relevant evidence in the resume
3. Assign a score (1-5 integer)
4. Write a concise evidence string (direct quote or summary)

Present as a table:

```
| Dimension       | Weight | Score | Evidence                                    |
|-----------------|--------|-------|---------------------------------------------|
| technical_depth | 0.35   | 4     | "Led platform migration serving 10M users"  |
| communication   | 0.25   | 3     | "Resume well-structured, no writing samples" |
| leadership      | 0.25   | 4     | "Managed team of 6, mentored 3 juniors"      |
| culture_fit     | 0.15   | 3     | "Startup + enterprise experience"            |
```

Note: Approximate weighted average shown for reference. Server computes the authoritative value.

### Step 4: Approval Gate

**[LLM]** Show HM the scoring table. Ask:

> "Approve these scores for [candidate name]? Adjust any dimension?"

Let HM adjust scores via natural language ("bump technical to 5", "communication should be 4 — she has a blog").

Repeat until HM approves.

### Step 5: Submit Scores

**[MCP]** Call `recruit_score` with:
```
{
  role, candidate_name, email, resume_markdown,
  scores: { dimension_name: { score, evidence } },
  portfolio_urls,
  approved: true
}
```

### Step 6: Display Result

**[LLM]** Show result from MCP:

```
Candidate Scored
━━━━━━━━━━━━━━━━
ID:      C-20260415-001
Name:    Alice Chen
Email:   alice@example.com
Score:   0.82 (pass threshold: 0.60)
State:   screened_pass ✓

Next: Schedule interview with /recruit-schedule
```

If `screened_reject`: explain the score is below threshold. HM can still proceed via `/recruit-schedule` if they override.

## Batch Scoring

If HM provides multiple resumes at once:
1. Convert all to Markdown first
2. Score each one independently
3. Present a summary table at the end, ranked by overall score
4. Call `recruit_score` once per candidate (not batched)

## Anti-patterns

| Pattern | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| Computing weighted average yourself | Server is authoritative; your math may differ | Show advisory estimate, let server compute |
| Score 3 for everything | No signal, defeats the framework | Each score needs specific resume evidence |
| Skipping evidence strings | Breaks audit trail and calibration | Every score must cite the resume |
| Scoring against wrong role framework | Wrong dimensions, wrong weights | Always verify role name before scoring |
| Skipping resume preview with HM | Conversion quality varies | Show markdown before scoring, ask HM to verify |
| Sending empty portfolio_urls | Clutters the record | Only include if HM provides URLs |
