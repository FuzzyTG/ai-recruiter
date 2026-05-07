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
- Treat candidate-supplied professional URLs as first-class research inputs: portfolio sites, GitHub/profile links, writing, demos, project pages, publications, talks, and other application-relevant professional links are extended CV material.
- Use public web/contextual sources only when they clarify candidate-supplied professional claims, company/product/project context, or role-relevant public professional evidence.
- Preserve separation between source-backed facts, inferences, unknowns, confidence, and sources.
- Saved source-backed facts require public HTTPS source URLs; inaccessible HTTP/private/internal sources should become unknowns or attribution limits with follow-up probes instead of saved facts.
- Research only public, role-relevant professional context. Do not investigate private personal life, family, politics, religion, health, age, ethnicity, gender, sexuality, disability, or any other protected characteristic.
- If public attribution is uncertain, state the attribution limit instead of treating it as fact.
- Delegate source-heavy research to a sub-agent for context isolation. Default to foreground dispatch so permission prompts surface naturally. Background dispatch is available as an opt-in when the HM has pre-approved search tools.
- After dispatching the research sub-agent, inform the HM that research will take a few minutes and they may see permission prompts for search tools.
- Review sub-agent results for structural quality before presenting cards to the HM.
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

Use candidate details, scores, structured `professional_urls`, portfolio URLs, resume-derived evidence, evaluations, conversation history, and any existing `research_cards` from the status response. Prefer structured `professional_urls` when present because they are deterministic candidate-supplied professional links extracted at intake; treat `portfolio_urls` and professional URLs in the resume/conversation as candidate-supplied source material, not third-party discovery targets. If resume text, structured URLs, portfolio URLs, role framework, or prior cards are unavailable, state the limitation briefly and avoid inventing details.

### Step 3: Extract Research Targets

**[LLM]** Identify 3–5 public, role-relevant claims worth checking. Prefer claims that are:
- Directly tied to the role framework or interview focus.
- Specific enough to verify or probe.
- High-signal for scope, ownership, technical depth, communication, or domain expertise.

Allowed claim areas:
- Public portfolio or project pages supplied by the candidate.
- Public professional profiles supplied by the candidate or already present in candidate data.
- Structured `professional_urls` from candidate status, including candidate-supplied GitHub/profile links, writing, demos, project pages, public talks, publications, repos, products, patents, or company/project pages relevant to the role.
- Public/contextual web sources that clarify those candidate-supplied professional claims without expanding into private-life or protected-characteristic investigation.

Disallowed claim areas:
- Private personal life or non-professional social media.
- Protected characteristics or proxies for protected characteristics.
- Sensitive personal data not supplied for recruiting purposes.
- Speculative identity matching beyond public professional context.

### Step 4: Dispatch Research Sub-agent

**[Agent]** Use the Agent tool to dispatch a research sub-agent (foreground by default — do NOT use `run_in_background: true`). Fill in the template below with candidate-specific data from Steps 2–3:

````text
Research the following candidate claims using public web sources. Return structured card data only — no prose, no commentary.

Candidate: {{candidate_name}} ({{candidate_id}})
Role: {{role}}

Claims to investigate:
{{#each claims}}
- Claim {{@index}}: {{claim}} — Priority: {{priority_reason}}
{{/each}}

Candidate-supplied professional URLs (use these as primary research targets — do not crawl all of them automatically, choose high-signal targets relevant to the claims above):
{{#each professional_urls}}
- {{url}} ({{category}}, source: {{source}})
{{/each}}
{{#if portfolio_urls}}

Portfolio URLs:
{{#each portfolio_urls}}
- {{url}}
{{/each}}
{{/if}}

Research rules:
- Use only public HTTPS sources. HTTP, private-network, local, or internal URLs must not appear in source_backed_facts.
- Separate source-backed facts from inferences. Never present an inference as a fact.
- Each inference must have a confidence level: low, medium, or high.
- Unknowns must be explicit — if you cannot verify a claim, say so rather than omitting it.
- If a source page is unavailable or only a search snippet exists, record it as an unknown or attribution_limit with a follow_up_probe, not as a fact.
- Do not investigate private personal life, family, politics, religion, health, age, ethnicity, gender, sexuality, disability, or any other protected characteristic.
- Do not treat company/product success as proof of candidate quality.
- Browser observations are extended CV material — they show what the candidate chose to present publicly, not independently verified achievements. Record what the page presents as evidence, not as proof of ownership or job performance.

Browser/headless tool guidance:
If browser or headless-browser tools (e.g. Playwright, Puppeteer, WebFetch with rendered content) are available in your environment, use them for candidate-supplied URLs (professional_urls, portfolio_urls) as primary research targets:
- Inspect professional and application-relevant pages to extract visible claims, project descriptions, technical details, and professional evidence.
- Optionally capture screenshots as visual observations to attach as evidence.
- If a site is inaccessible, sparse, or ambiguous, preserve that as an unknown with a follow-up probe — do not make negative assumptions about the candidate.
- Browser tools are optional. If unavailable, fall back to WebFetch/WebSearch and note the limitation in unknowns.

Return exactly one JSON array of card objects. Each card must have this structure:
{
  "claim": "<the claim being investigated>",
  "claim_type": "<project | public_profile | writing | talk | publication | company_context | other>",
  "priority_reason": "<why this claim is high-signal>",
  "source_backed_facts": [
    { "fact": "<verified fact>", "sources": [{ "title": "<page title>", "url": "<public HTTPS URL>" }] }
  ],
  "inferences": [
    { "inference": "<inference drawn from facts>", "confidence": "<low | medium | high>" }
  ],
  "unknowns": ["<what could not be verified>"],
  "attribution_limits": ["<what has uncertain attribution>"],
  "matching_relevance": "<how this relates to the role/interview>",
  "follow_up_probes": ["<interview question to clarify this claim>"],
  "use_in_scoring": "context_only"
}

Return the JSON array and nothing else.
````

After dispatch, tell the HM:

> "Researching [candidate name] now — this usually takes a few minutes. You may see permission prompts for search tools; please approve them."

**Background mode (opt-in):** If the HM asks for non-blocking research, tell them to add `WebSearch` and `WebFetch` to their `permissions.allow` in `.claude/settings.json`. Once pre-approved, you can use `run_in_background: true` safely. Only use background mode when the HM explicitly requests it AND confirms search tools are pre-approved.

### Step 5: Review Sub-agent Results

**[LLM]** When the sub-agent returns, review cards for structural quality before presenting to the HM:

- All required fields present (claim, claim_type, priority_reason, source_backed_facts, inferences, unknowns, attribution_limits, matching_relevance, follow_up_probes, use_in_scoring).
- Source-backed facts cite public HTTPS URLs only.
- Inferences have confidence levels (`low`, `medium`, or `high`).
- Unknowns are explicit, not omitted.
- Cards are scoped to the original claim list from Step 3.
- No more than 5 cards.

Fix structural issues inline without re-dispatching the sub-agent. If a source URL is HTTP, private, or inaccessible, move the associated fact to unknowns or attribution limits with a follow-up probe.

### Step 6: Draft Research Cards

**[LLM]** Present 3–5 reviewed cards using ASCII box-drawing format. Use box-drawing characters (`┌ ┐ └ ┘ │ ─ ├ ┤`) to draw each card as a distinct bordered box with sections separated by horizontal dividers. Show confidence levels inline as `[low]` `[med]` `[high]`. Source titles appear inline with facts. You do not need to align the right-side `│` to a fixed column — approximate alignment for readability is fine. Separate multiple cards with a blank line between boxes.

```text
Research Cards: <Candidate Name> (<candidate_id>)
Role: <role>

┌─────────────────────────────────────────────────────────┐
│ Card 1 — <claim>                                        │
│ Type: <claim_type>    Priority: <priority_reason>       │
├─────────────────────────────────────────────────────────┤
│ Facts:                                                  │
│  • <fact> [<source title>]                              │
├─────────────────────────────────────────────────────────┤
│ Inferences:                                             │
│  • <inference>                                    [med] │
├─────────────────────────────────────────────────────────┤
│ Unknowns:                                               │
│  • <unknown or attribution limit>                       │
├─────────────────────────────────────────────────────────┤
│ Relevance: <matching_relevance>                         │
├─────────────────────────────────────────────────────────┤
│ Probes:                                                 │
│  • <follow-up question>                                 │
├─────────────────────────────────────────────────────────┤
│ Scoring: context_only                                   │
└─────────────────────────────────────────────────────────┘
```

Keep claims tightly scoped. Do not include more than 5 cards.

### Step 7: Approval Gate

**[LLM]** Ask the HM which cards to save:

> "Approve these research cards for [candidate name]? You can approve all, approve selected card numbers, or request edits. Only approved cards will be saved."

If the HM requests edits, revise the draft and repeat the approval gate. Do not save until the HM clearly approves specific final cards.

### Step 8: Save Approved Cards

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

### Step 9: Display Result

**[LLM]** Show a concise result:

```text
Research Saved
━━━━━━━━━━━━━━
Candidate: <Name> (<candidate_id>)
Role:      <role>
Cards:     <N> context-only card(s)

These cards provide background context for interview preparation.
They do not affect candidate scores or ranking. Each card separates
verified facts from inferences and unknowns, so interviewers know
what's confirmed vs. what to probe further.

Next: Use `/recruit-prepare <candidate>` to generate targeted
interview questions informed by this research.
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
| Saving HTTP/private/internal URLs as source-backed facts | Saved facts must be persistable public HTTPS evidence | Put inaccessible or non-public sources in unknowns, attribution limits, or probes |
| Running research from `/recruit-prepare` | Prep must stay read-only and fast | Run `/recruit-research` first, then prep consumes saved cards |
| Running research inline in main context | Blocks the HM and pollutes main context with search results | Dispatch a sub-agent for context isolation (foreground default, background opt-in) |
| Skipping review of sub-agent results | Sub-agent may produce structural issues or non-HTTPS sources | Main agent reviews card structure before presenting |
| Re-dispatching sub-agent for minor fixes | Wastes time on a second round trip | Main agent corrects structural issues inline |
