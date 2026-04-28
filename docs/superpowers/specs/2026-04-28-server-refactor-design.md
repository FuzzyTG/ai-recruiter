# AI Recruiter Server Refactor Design

## Context

`src/server.ts` has grown to about 2,500 lines. It currently contains MCP tool registration, handler orchestration, email composition helpers, research-card validation, inbox sync, timeout automation, response helpers, and all public tool handlers.

This creates a maintenance risk: future feature work can keep adding unrelated responsibilities to the server entrypoint. The goal of this refactor is to reduce that risk without changing product behavior.

## Goal

Refactor `src/server.ts` into a thinner orchestration module by extracting isolated responsibilities into focused modules.

This is a behavior-preserving structural refactor. It should not add features, change MCP tool contracts, change storage layout, or alter pipeline behavior.

## Non-goals

- Do not split every `recruitX` tool handler into separate modules in this pass.
- Do not change candidate state transitions, audit behavior, email behavior, or status output.
- Do not redesign dependency injection.
- Do not add new MCP tools.
- Do not combine this refactor with product changes.

## Chosen approach

Use a mechanical extraction strategy.

Extract isolated code first, while leaving the main tool handlers inside `createHandlers()` for now. This reduces `server.ts` size and clarifies boundaries without disturbing the most fragile workflow sequencing.

## Target module boundaries

```text
src/
  server.ts              # createHandlers, createServer, handler orchestration
  toolSchemas.ts         # Zod schemas and MCP tool registration helpers
  researchCards.ts       # claim type constants + validateResearchCards()
  emailComposer.ts       # email parsing, signatures, generated follow-up bodies
  inboxSync.ts           # candidate matching and inbound sync helpers
  timeoutEngine.ts       # timeout automation execution
```

### `server.ts`

Keeps:

- `createHandlers(deps)`
- lazy API key and email client resolution
- public handler functions for this pass:
  - `recruitSetup`
  - `recruitScore`
  - `recruitSchedule`
  - `recruitEvaluate`
  - `recruitCompare`
  - `recruitDecide`
  - `recruitSaveResearchCards`
  - `recruitStatus`
  - `recruitCleanup`
- `createServer(deps)`
- current MCP response/error mapping if extracting it would create churn

### `researchCards.ts`

Owns research card validation and constants:

- `RESEARCH_CLAIM_TYPES`
- `validateResearchCards(cards)`

It must preserve current validation:

- 1–5 cards
- allowed `claim_type` values only
- at least one `source_backed_facts` entry per card
- at least one source per fact
- valid source URLs

### `emailComposer.ts`

Owns email body helpers:

- `parseEmailAddress()`
- `appendSignature()`
- `stripTrailingSignature()`
- `generateFollowupBody()`

This module should not know about MCP tools.

### `inboxSync.ts`

Owns inbound-message matching and status sync helpers:

- active candidate matching
- terminal thread ID collection
- fallback email count collection
- inbox sync execution
- guarded inbox sync that returns warnings instead of throwing

It should receive dependencies explicitly, especially store and email client access. It must preserve current sync behavior and return shape.

### `timeoutEngine.ts`

Owns timeout automation execution:

- auto follow-up
- auto transition
- HM notification
- timeout orchestration

It should receive dependencies explicitly, including store, config, email client, and email helper functions if needed.

### `toolSchemas.ts`

Owns MCP tool registration and Zod schemas.

It should receive the handler object from `server.ts` and call `server.tool(...)`. It should not contain business workflow logic.

## Dependency direction

Keep dependencies one-way:

```text
server.ts
  ├─ imports toolSchemas.ts
  ├─ imports researchCards.ts
  ├─ imports emailComposer.ts
  ├─ imports inboxSync.ts
  └─ imports timeoutEngine.ts
```

Extracted modules must not import `server.ts`.

## Error handling

Preserve existing MCP error semantics.

Keep existing error codes and response shapes:

- `setup_required`
- `role_not_found`
- `candidate_not_found`
- `illegal_transition`
- `approval_required`
- `validation_error`
- `internal_error`

Extracted modules may throw existing domain errors or return structured results, but they should not invent new MCP response formats. `server.ts` remains the boundary that turns domain errors into MCP tool results.

## Implementation sequence

Use small branches/checkpoints. Fix one boundary, verify it, then commit.

Recommended sequence:

1. Extract research-card validation.
2. Extract MCP schemas and registration.
3. Extract email composition helpers.
4. Extract inbox sync helpers.
5. Extract timeout engine.
6. Do final cleanup and review `server.ts` for remaining responsibilities.

If any step becomes risky, stop after the last passing checkpoint and reassess.

## Verification

Before and after each extraction batch:

```bash
npm --prefix "/Users/alexyuan/Downloads/Projects/ai-recruiter" run build
npm --prefix "/Users/alexyuan/Downloads/Projects/ai-recruiter" test -- tests/server.test.ts
```

At the end:

```bash
npm --prefix "/Users/alexyuan/Downloads/Projects/ai-recruiter" test
```

Expected outcome:

- all tests pass
- MCP tool names, schemas, and response shapes remain compatible
- no behavior changes are introduced
- `src/server.ts` becomes meaningfully smaller and more focused

## Commit strategy

Commit each successful extraction separately. Each commit should be behavior-preserving and have passing targeted tests.

Do not push until the full planned refactor batch is complete and the plugin version has been bumped if required by project instructions.
