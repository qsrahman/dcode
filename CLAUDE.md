# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dcode` — a CLI-based AI coding agent built on the OpenAI Responses SDK. Runs
locally via Node's type stripping (no build step). Currently at P3 (tool core +
read-only tools + agent loop); mutating tools, permissions, and MCP land in
later phases (see PLAN.md §8).

**Read [AGENTS.md](./AGENTS.md) and [PLAN.md](./PLAN.md) before changing code.**
AGENTS.md has the full developer guide (stack constraints, code style, config
precedence, testing conventions). PLAN.md §5 has the authoritative module tree
and §6 has 12 locked design decisions — do not reopen those without explicit
agreement.

## Commands

```sh
pnpm dev          # node --watch src/index.ts
pnpm test         # vitest run
pnpm test:watch   # vitest
pnpm typecheck    # tsc --noEmit  (gate)
pnpm format       # prettier --write .
pnpm format:check # prettier --check . (gate)
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
  `createLogger(config)` (`debug`/`info` gated by `config.verbose`, `warn`/`error`
  always emit).

## Architecture

`agent/run.ts` holds the low-level per-turn/per-tool primitives: `runTurn`
streams deltas from the OpenAI Responses client to a `sink` and returns the
full text plus the raw SDK response (so callers can inspect tool calls);
`runTool` executes a single tool call with a timeout and output truncation.
`agent/loop.ts` owns orchestration on top of those: `runAgent` drives the
tool-calling loop (stream a turn, run any tool calls in parallel, feed
`function_call_output`s back, repeat up to `maxToolIterations`), and
`runOneShot` is a thin wrapper that builds `[system, user]` and delegates to
`runAgent`. Tools live under `tools/`: `tools/registry.ts`'s `ToolRegistry`
registers `Tool` objects (zod-typed params, converted to Responses JSON
Schema via `z.toJSONSchema`) and `tools/local/fs.ts` implements the read-only
set (`read_file`, `list_dir`, `grep`, `stat`, `glob`) over a shared
`walkDirs` traversal, path-confined to the working directory.

The REPL (`cli/repl.ts` + `cli/commands.ts`) reuses `runAgent` directly,
keeping a module-local `Session` (`{ config, client, logger, history, tools }`)
and dispatching slash commands (`parseCommand`/`dispatch` in `commands.ts`)
before falling through to a model turn. `index.ts` wires CLI args -> config ->
either `runOneShot` (prompt given, with its own `ToolRegistry`) or `startRepl`
(no prompt, builds its own `ToolRegistry` inside `createSession`).

Config resolution precedence is **CLI > env > file > schema defaults**,
implemented as pure `mergeConfigs` in `config/config.ts` with `config/schema.ts`
(zod) as the source of truth for shape and defaults. `resolveRoot(config)`
(also in `config/config.ts`) is the single place that resolves the effective
working-directory root (`config.root ?? process.cwd()`), used by both the
system prompt and the tool context.

See PLAN.md §5 for the full target module tree (including mutating tools,
permissions, and MCP modules not yet built) and §10+ for the current phase's
detailed spec.

## Testing

Tests live in `tests/`, mirroring `src/` (`tests/cli/args.test.ts` ->
`src/cli/args.ts`). Mock external boundaries (OpenAI client, `child_process`,
`fs`); assert colored output against `ansis.strip(...)`. `tests/helpers.ts`
holds shared fakes (e.g. a fake streaming client) used across suites.
