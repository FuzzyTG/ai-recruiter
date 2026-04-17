# AI Recruiter

A recruiting domain package that turns your AI assistant into a recruiting coordinator.

AI Recruiter is **domain expertise for AI agents** — skill files that encode recruiting workflow knowledge, backed by validated tools that enforce hiring rules. It does not replace your agent or build its own. It makes your existing agent capable of managing a full hiring pipeline.

## Why

Hiring managers spend hours on coordination — chasing candidates for scheduling replies, tracking who's in what stage, drafting emails, enforcing consistent evaluation criteria. The actual *decisions* (should we interview this person? should we hire them?) take minutes. Everything around those decisions takes days.

AI Recruiter automates the coordination so the hiring manager focuses on judgment calls, not logistics.

## How It Works

The hiring manager talks to their AI assistant naturally: "Screen this candidate," "Schedule an interview with Smith," "Who's overdue?" Behind the scenes:

1. The agent loads a **skill file** — step-by-step recruiting knowledge for that workflow
2. The agent follows the protocol: gathers info, drafts communication, shows the HM for approval
3. On approval, the agent calls a **tool** that validates the action, sends emails, updates state
4. The HM stays in control — every consequential action requires explicit approval

The skill files are the brain. The tools are the hands. The agent harness is the conversation layer. AI Recruiter provides the first two.

```
┌─────────────────────────────────────────────────────────┐
│  Hiring Manager                                         │
│  (natural language)                                     │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Agent Harness (Claude Code, OpenClaw, etc.)            │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Skill Files — recruiting domain knowledge that    │ │
│  │  drives the workflow: what to do, when, and how    │ │
│  └────────────────────────┬───────────────────────────┘ │
│                           │ tool calls                   │
│  ┌────────────────────────▼───────────────────────────┐ │
│  │  Tools (MCP) — validated actions with built-in     │ │
│  │  state machine, approval gates, and safety checks  │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────▼─────┐    ┌──────▼─────┐    ┌──────▼─────┐
    │ Channels │    │  Calendar  │    │   Store    │
    │ (email,  │    │  (ICS)     │    │  (JSON)    │
    │  future  │    │            │    │            │
    │  SMS...) │    │            │    │            │
    └──────────┘    └────────────┘    └────────────┘
```

## Architecture

AI Recruiter is designed in concentric layers. The inner layers are stable; outer layers can be added without changing the core.

```
        ┌─────────────────────────────────────┐
        │     Web Application (future)        │
        │  ┌───────────────────────────────┐  │
        │  │  Agent Harnesses              │  │
        │  │  Claude Code, OpenClaw        │  │
        │  │  ┌─────────────────────────┐  │  │
        │  │  │  AI Recruiter Package   │  │  │
        │  │  │  Skills + Tools         │  │  │
        │  │  └─────────────────────────┘  │  │
        │  └───────────────────────────────┘  │
        └─────────────────────────────────────┘
```

- **Core: Domain Package** — Skill files + MCP tools. The skill files encode recruiting workflow knowledge. The tools enforce state transitions, approval gates, preflight validation, and channel integrations. Together, they are the product.
- **Integration surface: Agent Harnesses** — Claude Code and OpenClaw are the current targets. They load skill files and call tools. This is a pro-user tool today — you interact through your AI assistant, not a GUI.
- **Future: Web Application** — A web UI, API layer, multi-tenant deployment. The core package doesn't change — you wrap it with a different interface.

## Skill Files

Skill files are markdown documents in `commands/` that encode recruiting domain knowledge. Each file corresponds to a workflow step and tells the agent exactly how to execute it — what rules to follow, what approvals to require, what validations the server will enforce, and what sequence of tool calls to make.

The agent harness loads the relevant skill file when the HM invokes a command (e.g., `/recruit-schedule`). The skill file drives the conversation.

| Skill File | Workflow Step |
|------------|---------------|
| `recruit-setup.md` | Configure a role — rubric, channels, calendar |
| `recruit-score.md` | Screen and score a candidate |
| `recruit-schedule.md` | Interview lifecycle — propose, confirm, resend, cancel, homework, no-show |
| `recruit-evaluate.md` | Post-interview evaluation |
| `recruit-compare.md` | Cross-candidate comparison |
| `recruit-decide.md` | Hiring decision and notification |
| `recruit-status.md` | Pipeline status and timeout sweeps |

### What a skill file contains

Each skill file includes:

- **Rules** — hard constraints the agent must follow (e.g., "LLM composes body text only — no signatures, no sign-offs. The server appends the signature automatically.")
- **Dependency guard** — what to check before proceeding (candidate state, setup status)
- **Step-by-step protocol** — the exact workflow: gather info → draft email → show to HM → get approval → call tool
- **Approval gates** — which actions require explicit HM confirmation before the tool call executes
- **Edge cases** — what to do when things go wrong (candidate in wrong state, email validation failure)

The skill files are the primary mechanism by which a general-purpose agent gains recruiting expertise. The tools enforce the rules; the skill files teach the agent to follow them.

## The Hiring Pipeline

Candidates flow through a state machine. Each transition is validated by the tools. Key transitions require HM approval.

```
sourced → screened_pass ──→ scheduling ──→ interview_confirmed ──→ interview_done
   │              │              │                  │                      │
   └→ screened    └→ screened    └→ withdrawn       ├→ no_show             └→ evaluating
      _reject        _reject                        └→ scheduling               │
                                                       (cancel)           ┌─────┴──────┐
                                                                          │            │
                                                                    homework      calibration
                                                                    _assigned          │
                                                                       │          decision
                                                                    homework      _pending
                                                                    _overdue       │    │
                                                                                hired  rejected
                                                                                       │
                                                                                    withdrawn
```

### Approval gates

Actions with consequences require explicit HM approval. The agent shows the HM what will happen (e.g., the full email draft), the HM says "yes," and only then does the agent call the tool with `approved: true`. If `approved` is not set, the tool rejects the call.

| Action | Requires Approval |
|--------|:-:|
| Screening decisions (pass/reject) | Yes |
| Sending scheduling emails | Yes |
| Confirming interview slot | Yes |
| Cancelling an interview | Yes |
| Marking no-show | Yes |
| Hiring / rejection decisions | Yes |
| Marking interview done | No (factual observation) |
| Timeout follow-ups | No (system-generated) |

### Hard rules

- **Side effects before state transitions**: Emails and calendar invites execute *before* state transitions. If the email fails, state remains unchanged. No silent failures, no inconsistent state.
- **LLM composes body only**: The agent drafts email body text. The server strips any trailing signature the LLM added and appends the canonical signature from config. The LLM never controls structural elements.
- **Preflight validation**: Outbound messages are validated before sending — date-weekday correctness, language matching, required fields.

## Tools

The package exposes 7 workflow tools via MCP:

| Tool | Purpose |
|------|---------|
| `recruit_setup` | Configure a role — job details, scoring rubric, channels, calendar |
| `recruit_score` | Screen and score a candidate against the rubric |
| `recruit_schedule` | Manage interview lifecycle — propose slots, confirm, resend, cancel, send homework, mark no-show, mark interview done |
| `recruit_evaluate` | Record post-interview evaluation |
| `recruit_calibrate` | Cross-candidate comparison and calibration |
| `recruit_decide` | Make and communicate hiring decisions |
| `recruit_status` | Query pipeline state, check inbox, run timeout sweeps |

## Channels

The tools communicate with candidates through a channel abstraction. Email (via AgentMail) is the current implementation. The architecture supports adding new channels without changing the workflow logic.

- **Preflight checks** validate outbound messages before sending
- **Conversation log** records all inbound and outbound messages per candidate

## Setup

### Option 1: Claude Code Plugin (recommended)

```bash
# Add the marketplace
/plugin marketplace add FuzzyTG/ai-recruiter

# Install the plugin — you'll be prompted for your AgentMail API key during install
/plugin install ai-recruiter@fuzzytg

# Start using
/recruit-setup
```

You'll need an [AgentMail](https://agentmail.to) API key. The plugin prompts for it during installation. Dependencies install automatically on first session — no manual `npm install` needed.

### Option 2: Manual MCP Server

Prerequisites: Node.js 20+, an MCP-compatible agent harness, an [AgentMail](https://agentmail.to) account.

```bash
git clone https://github.com/FuzzyTG/ai-recruiter.git
cd ai-recruiter
npm install
cp .mcp.json.example .mcp.json
# Edit .mcp.json with your AgentMail API key
```

Then configure as an MCP server in your agent harness (e.g., copy `.mcp.json` to `~/.claude.json`).

### First Run

Call `recruit_setup` (or `/recruit-setup` in Claude Code) to configure a role with:

- Hiring manager details and email
- Scoring rubric and dimensions
- Channel configuration (AgentMail inbox ID)
- Calendar source (ICS URL for availability)

Configuration is stored in `~/.recruiter/config.json`. Candidate data is stored as JSON files in `~/.recruiter/roles/`.

## Development

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Start the server directly
npm start
```

### Extending

- **New workflow actions**: Add to the `recruit_schedule` handler in `server.ts` with state validation and approval gates
- **New channels**: Implement the channel interface in a new adapter alongside `emailClient.ts`
- **New timeout rules**: Add to `TIMEOUT_RULES` in `models.ts` — the timeout engine picks them up automatically
- **New skill files**: Add markdown files to `commands/` following the existing patterns — rules, dependency guard, step-by-step protocol, approval gates

## Vision

AI Recruiter is one half of a broader talent system.

**AI Recruiter** (this product) manages the hiring pipeline — screening, interviewing, evaluating, and deciding. It starts when a candidate is already identified.

**A companion sourcing system** (future, separate product) handles everything upstream — continuously discovering talent, building relationships through lightweight social engagement, and surfacing pre-warmed candidates when a role opens. When it's time to activate a candidate, they flow into AI Recruiter's pipeline as `sourced`.

The two products are loosely coupled: the sourcing system feeds candidates in, AI Recruiter processes them through. Together, they cover the full talent lifecycle — from "who's out there" to "you're hired" — shifting from cold outreach (~10% response rate) to warm outreach (~60-70%) while the hiring manager focuses on decisions, not sourcing legwork. The core principle across both: **AI does the work of a recruiting team. The hiring manager does the talking.**

## License

MIT
