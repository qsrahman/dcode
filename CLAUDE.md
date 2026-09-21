# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

`dcode` — a CLI coding agent built on the OpenAI Responses SDK. One-shot
(`dcode "prompt"`) or REPL (`dcode`). Runs locally via Node's type stripping
(no build step). Phases P0–P11 and P6 are complete, plus streamed markdown
rendering, `ask_user`, and sub-agents (the `task` tool). P5 (declarative
permissions) was cancelled and its gate removed — **all tool calls run
unconditionally, MCP tools included**. P9's scoped `git` tool was removed (it
added no safety over the ungated `run_shell`); git is reached via `run_shell`.
P12 (symbol search) and P13 (apply_patch) are planned. See PLAN.md §8.

**Read [AGENTS.md](./AGENTS.md) and [PLAN.md](./PLAN.md) before changing code.**
AGENTS.md is the developer guide (stack constraints, code style, config
precedence, testing, security model). PLAN.md §5 has the module tree and §6 has
12 locked design decisions — do not reopen those without explicit agreement.
[ONBOARDING.md](./ONBOARDING.md) explains how the system works: entry points,
the agent loop traced step by step, each component, and how to debug. The code
comments carry the *why* behind individual choices; this file does not repeat
them.

## Commands

```sh
pnpm dev          # node --watch src/index.ts
pnpm test         # vitest run
pnpm test:watch   # vitest
pnpm typecheck    # tsc --noEmit  (gate)
pnpm format       # prettier --write .
pnpm format:check # prettier --check . (gate)
pnpm stress       # live end-to-end stress test (scripts/live-stress.ts)
```

Run a single test file: `pnpm vitest run tests/cli/repl.test.ts`.

Before committing: `pnpm typecheck && pnpm format:check && pnpm test` (per
AGENTS.md's phase workflow).

## Hard constraints (from AGENTS.md — non-negotiable)

- Node 26+ type stripping: no `tsc` build; `node src/index.ts` runs it directly.
- TypeScript 7+, strict, ESM (`"type": "module"`).
- pnpm only — never `npm`/`yarn`.
- `node:` prefix for builtins; `.ts` extension on relative imports; `import type`
  for type-only imports (`verbatimModuleSyntax` is on).
- No `enum`, runtime `namespace`, parameter properties, or `import x = require()`
  — Node's strip-only mode rejects them. Use `const` objects + union types.
- `console.log`/`process.stdout` is reserved for streamed model output and the
  REPL prompt only. Everything else goes to stderr via `util/log.ts`'s
  `createLogger(config)` (`debug` gated by `--verbose`, `warn`/`error` always
  emit).

## Easy to break

Each of these is enforced by code that looks arbitrary; the linked comment or
ONBOARDING.md §17 says why.

- **History invariants.** Every `function_call` needs its `function_call_output`
  (the loop records outputs before honoring an abort). Model output is replayed
  via the SDK's `toResponseInputItems()` so `reasoning` items survive, then
  `loop.ts` strips `parsed_arguments`. Count, undo, or cut at prompts with
  `isUserPrompt` (`agent/types.ts`), never a bare `role === 'user'`: the
  injected `Continue.` is a user item too.
- **The system prompt is not history.** It goes in the Responses `instructions`
  field, rebuilt per prompt by `buildSystemPrompt()`, which also appends the
  cwd's `AGENTS.md`/`CLAUDE.md`. Tests pass `root` to keep this repo's own file
  out.
- **Tools.** Define with `defineTool` (args inferred from the zod schema; never
  a hand-written `ToolDefinition<{…}>`), set `category`, and `parallel: false`
  if it mutates state. Register in `tools/index.ts::createLocalTools`;
  `tests/tools/index.test.ts` pins the exact built-in list. MCP tools use the
  server's JSON Schema verbatim (`jsonSchema`).
- **Cancellation.** `runTool`'s deadline *abandons* a tool rather than stopping
  it, so anything that spawns or connects must also take `ctx.signal`. A tool
  that would block on stdin refuses up front (`ask_user`).
- **Terminal output.** The live tool counter freezes at the first visible answer
  chunk (`onBeforeText`), which assumes tool-calling turns emit no text. Colour
  comes only from `paintFor(config.color)` in `util/color.ts`.
- **Search.** `grep`/`glob` spawn ripgrep directly (its exit code 1 means "no
  matches"), and `config.ignore` globs must be appended *after* the caller's.
- **Sub-agents.** `explore` is a read-only **allow-list** on purpose; `general`
  is a deny-list (`task`). `createLocalTools` throws on a policy name nobody
  registers.
- **Config.** The file parse is strict (a typo'd key fails), nested defaults are
  derived rather than literal, `verbose` is CLI-only, and `/key` always writes the
  global config.

## Testing

Tests live in `tests/`, mirroring `src/` loosely (ONBOARDING.md §12 lists where
each module's tests are). Mock external boundaries (OpenAI client,
`child_process`, `fs`); assert colored output against `node:util`'s
`stripVTControlCharacters(...)`. `tests/helpers.ts` holds shared fakes (e.g. a
fake streaming client). `pnpm stress` (`scripts/live-stress.ts`) is the live
end-to-end counterpart: it talks to the real model over this repository and is
never part of `pnpm test`.
