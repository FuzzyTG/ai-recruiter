# AI Recruiter

AI Recruiter is **recruiting domain expertise packaged for AI agents**.

Today it ships as a Claude Code plugin and MCP server. That is the minimum form for proving the MVP, not the product boundary. The larger goal is to give AI agents the recruiting-specific protocols, state machine, approval gates, and validated tools they need to act like a reliable recruiting coordinator.

## Why this exists

Hiring is not only decision-making. Most of the work is coordination: screening consistently, chasing scheduling replies, preparing interviews, collecting feedback, comparing candidates, and communicating outcomes.

A general-purpose AI agent can help, but only if it knows the recruiting workflow and has safe tools for consequential actions. AI Recruiter provides that domain layer.

The hiring manager stays accountable for judgment calls. The agent handles the coordination work, and the server enforces the rules.

## What it is today

AI Recruiter currently includes:

- **Command files** in `commands/` that teach the agent recruiting workflows.
- **MCP tools** that validate actions, update state, send approved communication, and enforce approval gates.
- **A JSON store** for roles, candidates, evaluations, messages, and framework versions.
- **AgentMail-backed email** for candidate communication through a delegated coordinator identity.
- **ICS calendar support** for interview scheduling.

Claude Code is the first host. Other agent harnesses can use the same domain package through MCP.

## What it can do

- Configure a role, hiring pipeline, calendar, and evaluation framework.
- Screen and score candidates against a role-specific framework.
- Schedule, confirm, resend, cancel, and track interviews.
- Record post-interview evaluations.
- Compare candidates with framework-version awareness.
- Make and communicate hiring decisions.
- Query status, inbox activity, overdue candidates, and cleanup actions.

## Core principles

### Hiring manager control

Consequential actions require explicit hiring manager approval. The agent shows what will happen first; only then does it call the tool with approval.

Examples include screening decisions, scheduling emails, interview confirmations, cancellations, hiring decisions, and rejection notices.

### Server-enforced safety

The server validates state transitions, required fields, message structure, calendar consistency, and approval flags. If a side effect fails, state does not advance silently.

### Delegated coordinator identity

Candidate-facing email should come from a coherent delegated recruiting coordinator identity, not from the hiring manager's personal or corporate mailbox.

For example:

```text
Grace - AI Recruiting Coordinator <grace@agentmail-domain>
```

The hiring manager remains visible and accountable through approval and CC rules, but the coordinator identity owns the operational communication flow.

### Framework versioning

Confirmed evaluation frameworks are immutable. Any later change creates a new framework version under the same role.

Candidate scores and evaluations record the framework version used. Comparisons distinguish between:

- same-version scores,
- mixed versions with compatible weighting changes,
- mixed versions with structural changes that require re-score before clean ranking.

### LLM body only

The LLM writes candidate-facing body text only. The server owns structure, signatures, disclaimers, validation, and delivery.

## How it works

1. The hiring manager invokes a recruiting command, such as `/recruit-score` or `/recruit-schedule`.
2. The command file guides the agent through the workflow.
3. The agent gathers information, drafts communication if needed, and asks for approval.
4. On approval, the agent calls an MCP tool.
5. The tool validates the action, performs side effects, and records state.

The command files are the workflow brain. The MCP tools are the validated hands.

## Tools

AI Recruiter exposes these workflow tools through MCP:

| Tool | Purpose |
|------|---------|
| `recruit_setup` | Configure roles, frameworks, calendar, and communication settings |
| `recruit_score` | Screen and score candidates |
| `recruit_schedule` | Manage interview scheduling lifecycle |
| `recruit_evaluate` | Record post-interview evaluations |
| `recruit_compare` | Compare candidates with framework-version awareness |
| `recruit_decide` | Make and communicate hiring decisions |
| `recruit_status` | Query pipeline state, inbox, and overdue work |
| `recruit_cleanup` | Inspect and clean local recruiter data |

## Install

### Claude Code plugin

Install from the latest marketplace version:

```bash
/plugin marketplace add FuzzyTG/ai-recruiter
/plugin install ai-recruiter@fuzzytg
```

To pin to a stable release tag instead of latest:

```bash
/plugin marketplace add FuzzyTG/ai-recruiter@v0.1.12
/plugin install ai-recruiter@fuzzytg
```

To return to latest later, remove and re-add the marketplace without a tag:

```bash
/plugin marketplace remove fuzzytg
/plugin marketplace add FuzzyTG/ai-recruiter
/plugin update ai-recruiter
```

Then start with:

```bash
/recruit-setup
```

Dependencies install automatically on session start. You need an AgentMail API key available to the MCP server as `AGENTMAIL_API_KEY`.

### Manual MCP server

```bash
git clone https://github.com/FuzzyTG/ai-recruiter.git
cd ai-recruiter
npm install
cp .mcp.json.example .mcp.json
```

Edit `.mcp.json` with your AgentMail API key, then configure it in your MCP-compatible agent harness.

## First run

Use `/recruit-setup` to configure:

- hiring manager details,
- delegated coordinator communication identity,
- role and evaluation framework,
- calendar availability through ICS,
- candidate communication settings.

Configuration is stored in `~/.recruiter/config.json`. Role and candidate data are stored under `~/.recruiter/roles/`.

## Development

```bash
npm test
npm run build
npm start
```

Key source areas:

- `commands/` — recruiting workflow commands for the agent.
- `src/server.ts` — MCP tool registration and workflow handlers.
- `src/store.ts` — JSON persistence and framework versioning.
- `src/emailClient.ts` — AgentMail integration.
- `src/models.ts` — core data models and pipeline states.
- `tests/` — tool, store, model, validator, calendar, and integration tests.

## Vision

AI Recruiter is one example of a broader pattern: **domain packages for AI agents**.

The product is not the Claude Code plugin itself. The plugin is the first working package format. The durable value is the recruiting expertise: protocols, state machines, validation rules, evaluation models, communication constraints, and workflow memory that let an AI agent do domain work safely.

Recruiting is the first domain because it is coordination-heavy, judgment-sensitive, and full of repeatable operational work. The same pattern can extend to other agent hosts: Claude Code, OpenClaw, web apps, or future agent runtimes.

A companion sourcing system may eventually handle the upstream work of discovering and warming candidates. AI Recruiter starts when a candidate enters the hiring pipeline and manages the path from screening to decision.

The long-term principle is simple: AI agents do the coordination work; humans remain accountable for judgment, approval, and final decisions.

## License

MIT
