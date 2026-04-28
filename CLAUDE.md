# AI Recruiter — Project Instructions

## Memory Recall
- **Session start**: At the beginning of every session, run `memex read index` and scan for cards relevant to the current task. Read 2-3 most relevant cards before starting work.
- **Before debugging**: When diagnosing an issue, search memex for related patterns before tracing code from scratch.

## Before Pushing
- **Always bump the patch version** in `.claude-plugin/plugin.json` before every `git push` (e.g. 0.1.1 → 0.1.2). Without this, the Claude Code plugin update mechanism won't detect changes.

## Architecture Guardrails
- **Keep `src/server.ts` as orchestration, not a dumping ground.** It may register MCP tools, wire dependencies, and route to handlers. Do not add large business workflows, parsing logic, email composition, timeout engines, inbox sync logic, or research synthesis directly into `server.ts`.
- **Choose a boundary before adding substantial server logic.** Tool-specific behavior belongs in focused handler modules; durable storage belongs in `store.ts` or a focused storage module; email composition belongs in an email-focused module; inbox sync/matching belongs in an inbox sync module; timeout automation belongs in a timeout engine module; Claude Code command reasoning belongs in command markdown, not MCP server code.
- **Use file size as a design trigger.** If a source file approaches ~1,000 lines, pause and consider extraction before adding more responsibilities. If it exceeds ~1,500 lines, new feature work should include a refactoring plan unless the change is trivial.
- **Maintain MCP tool discipline.** Do not add MCP tools for cognitive work such as research, ranking, scoring interpretation, or synthesis. MCP tools should expose durable state, validation, retrieval, and explicit side effects.
- **Refactor safely.** Prefer small, behavior-preserving extractions with tests passing before and after. Do not mix large structural refactors with product behavior changes unless explicitly planned.

## Before Running OPC
- **Commit or stash all local changes** before invoking OPC. This ensures `git diff` after OPC finishes shows exactly what OPC changed — nothing mixed in from prior work.

## Email Composition
- **LLM composes body text only.** Do not include sign-offs, signatures, or disclaimers — the server appends those via `appendSignature()`.
- **Plain text only in `email_body`.** No Markdown formatting — emails are sent as `text/plain`.
