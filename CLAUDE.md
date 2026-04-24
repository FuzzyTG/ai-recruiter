# AI Recruiter — Project Instructions

## Before Pushing
- **Always bump the patch version** in `.claude-plugin/plugin.json` before every `git push` (e.g. 0.1.1 → 0.1.2). Without this, the Claude Code plugin update mechanism won't detect changes.

## Before Running OPC
- **Commit or stash all local changes** before invoking OPC. This ensures `git diff` after OPC finishes shows exactly what OPC changed — nothing mixed in from prior work.

## Email Composition
- **LLM composes body text only.** Do not include sign-offs, signatures, or disclaimers — the server appends those via `appendSignature()`.
- **Plain text only in `email_body`.** No Markdown formatting — emails are sent as `text/plain`.
