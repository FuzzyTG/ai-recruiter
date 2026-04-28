---
name: recruit-research
description: Research public candidate context and save approved research cards
---

## Rules

- This command owns the research workflow and reasoning. Do not create or call MCP tools for research, ranking, scoring, or synthesis.
- Use MCP only for status lookup and for saving HM-approved cards via `recruit_save_research_cards`.
- Research is context-only. Never change scores, candidate state, pending actions, rankings, or pipeline decisions.
- Save only cards explicitly approved by the HM.
- Produce only the top 3–5 high-signal claims.
- Preserve separation between source-backed facts, inferences, unknowns, confidence, and sources.
- Research only public, role-relevant professional context. Do not investigate private personal life, family, politics, religion, health, age, ethnicity, gender, sexuality, disability, or any other protected characteristic.
- If public attribution is uncertain, state the attribution limit instead of treating it as fact.
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

If `role_not_found` or `candidate_not_found` is returned, show a short friendly error and stop.

Use candidate details, scores, portfolio URLs, resume-derived evidence, evaluations, conversation history, and any existing `research_cards` from the status response. If resume text, portfolio URLs, role framework, or prior cards are unavailable, state the limitation briefly and avoid inventing details.

### Step 3: Extract Research Targets

**[LLM]** Identify 3–5 public, role-relevant claims worth checking. Prefer claims that are:
- Directly tied to the role framework or interview focus.
- Specific enough to verify or probe.
- High-signal for scope, ownership, technical depth, communication, or domain expertise.

Allowed claim areas:
- Public portfolio or project pages supplied by the candidate.
- Public professional profiles supplied by the candidate or already present in candidate data.
- Public talks, publications, repos, writing, products, patents, or company/project pages relevant to the role.

Disallowed claim areas:
- Private personal life or non-professional social media.
- Protected characteristics or proxies for protected characteristics.
- Sensitive personal data not supplied for recruiting purposes.
- Speculative identity matching beyond public professional context.

### Step 4: Research Public Context

**[LLM]** Use appropriate read-only web/research tools available in Claude Code for public sources. Keep source notes concise.

For each claim, collect:
- Source-backed facts with source title and URL.
- Inferences clearly marked separately from facts.
- Confidence for each inference: `low`, `medium`, or `high`.
- Unknowns and attribution limits.
- Matching relevance to the role/interview.
- Follow-up probes for the interviewer.

Do not treat search snippets as authoritative when the source page is unavailable. If the source cannot be checked, mark it as an unknown or attribution limit.

### Step 5: Draft Research Cards

**[LLM]** Present 3–5 cards in this structure:

```text
Research Cards: <Candidate Name> (<candidate_id>)
Role: <role>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Card 1 — <claim>
Claim type: <project | public_profile | writing | talk | publication | company_context | other>
Priority reason: <why this is high-signal>

Source-backed facts:
- <fact> [<source title>: <URL>]

Inferences:
- <inference> (confidence: low|medium|high)

Unknowns / attribution limits:
- <unknown or limit>

Matching relevance:
- <role/interview relevance>

Follow-up probes:
- <question>

Use in scoring: context_only
```

Keep claims tightly scoped. Do not include more than 5 cards.

### Step 6: Approval Gate

**[LLM]** Ask the HM which cards to save:

> "Approve these research cards for [candidate name]? You can approve all, approve selected card numbers, or request edits. Only approved cards will be saved."

If the HM requests edits, revise the draft and repeat the approval gate. Do not save until the HM clearly approves specific final cards.

### Step 7: Save Approved Cards

**[MCP]** Call `recruit_save_research_cards` with only approved cards:

```json
{
  "role": "<role>",
  "candidate_id": "<candidate_id>",
  "approved": true,
  "cards": [
    {
      "claim": "...",
      "claim_type": "...",
      "priority_reason": "...",
      "source_backed_facts": [
        {
          "fact": "...",
          "sources": [{ "title": "...", "url": "..." }]
        }
      ],
      "inferences": [
        { "inference": "...", "confidence": "medium" }
      ],
      "unknowns": ["..."],
      "attribution_limits": ["..."],
      "matching_relevance": "...",
      "follow_up_probes": ["..."],
      "use_in_scoring": "context_only"
    }
  ]
}
```

### Step 8: Display Result

**[LLM]** Show a concise result:

```text
Research Saved
━━━━━━━━━━━━━━
Candidate: <Name> (<candidate_id>)
Role:      <role>
Cards:     <N> context-only card(s)

Next: Use `/recruit-prepare <candidate>` to generate interview prep with saved research context.
```

## Anti-patterns

| Pattern | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| Creating a research MCP tool | Research workflow belongs in Claude Code command reasoning | Use normal Claude Code research tools and save only approved cards |
| Saving draft or unapproved cards | Persists context the HM did not accept | Save only explicitly approved final cards |
| Updating score or state | Research is enrichment, not evaluation | Keep `use_in_scoring: "context_only"` |
| Saving 10+ low-signal facts | Overwhelms interview prep | Keep top 3–5 high-signal claims |
| Mixing facts with inferences | Misleads interviewers about evidence strength | Separate facts, inferences, unknowns, confidence, and sources |
| Researching private/protected traits | Irrelevant and discriminatory | Restrict to public professional, role-relevant context |
| Running research from `/recruit-prepare` | Prep must stay read-only and fast | Run `/recruit-research` first, then prep consumes saved cards |
