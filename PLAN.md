# PLAN.md — dcode

Product Requirements Document for **dcode**, a CLI-based AI coding agent built on
the OpenAI Responses SDK.

Status: **P0 (scaffold) complete.** Phases advance one at a time; each lands as
code + tests + docs + a focused commit. This document is the source of truth for
features, architecture, and conventions — keep it in sync after every phase.

## 1. Vision

A small, modular, locally-run coding agent you drive from a terminal:

- One-shot: `dcode "add a CLI flag to parse --verbose"`
- REPL: `dcode` then chat, with slash commands.
- Uses local system tools (files, shell, git) and optional MCP servers.
- Fully async agent loop; read-only tools run in parallel.
- Streaming model output, configurable models, a declarative permission system.

## 2. Goals

- Correctness and simplicity over feature breadth.
- Modular enough to add tools/transports without refactoring the loop.
- Every behavior covered by fast, deterministic unit tests.
- No build step: Node 26 runs `.ts` directly via type stripping.

## 3. Non-goals (v1)

- Multi-agent orchestration / sub-agents.
- Conversation persistence across runs (ephemeral in v1).
- Browser/UI; this is a terminal tool.
- Provider abstraction beyond OpenAI-compatible endpoints (configurable base URL).

## 4. Stack

- **Runtime:** Node.js 26+ (type stripping, no `tsc` build).
- **Language:** TypeScript 7+ (strict, ESM, `erasableSyntaxOnly`).
- **Package manager:** pnpm only.
- **Tests:** Vitest 4+.
- **Runtime deps:** `zod`, `ansis`, `openai`.
- **Dev deps:** `typescript`, `@types/node`, `prettier`, `vitest`.

### Type-stripping caveats (hard constraints)

Node 26 strips types but does **not** transform. Therefore:

- No `enum`, runtime `namespace`, parameter properties, or `import x = require()`.
- Use `const` objects + union types instead of enums.
- Relative imports require the `.ts` extension; type-only imports use `import type`.
- `tsc --noEmit` is the typecheck gate (Node never type-checks).

## 5. Architecture

```
src/
  index.ts            # entry: parse CLI -> build config -> one-shot or REPL
  cli/args.ts         # parseCli(argv) -> ParsedArgs (pure, fully tested)
  cli/repl.ts         # readline loop + slash-command dispatch
  config/schema.ts    # zod schemas (AppConfig + permissions policy)
  config/config.ts    # loadConfig(path) + merge(CLI, file, env)
  agent/client.ts     # wraps OpenAI Responses API (stream + one-shot)
  agent/loop.ts       # runTurn: stream -> collect tool calls -> execute -> feed back
  agent/types.ts      # Tool, ToolResult, AgentInput
  tools/registry.ts   # register/list/get; zod->JSON-schema for Responses defs
  tools/local/fs.ts   # read_file, list_dir, grep            (read-only)
  tools/local/write.ts# write_file, edit_file                (mutating)
  tools/local/shell.ts# run shell command                   (mutating)
  tools/local/git.ts  # status/diff/log (+ add/commit)       (mixed)
  tools/mcp/manager.ts# connect servers, cache tools, callTool
  permissions/policy.ts  # declarative evaluate(tool,args,mode,rules) -> allow/deny/ask
  permissions/harness.ts # executeToolCall: policy -> (auto/ask/deny) -> run
  ui/render.ts        # ansis output: streamed text, tool status lines, timing
  ui/prompt.ts        # permission prompt (y/n/a) + REPL prompt
  util/log.ts         # diagnostics -> stderr (never console.log)
```

### Agent loop

1. Send conversation `input` + tool defs to the Responses API (streaming).
2. Render streamed text; collect `function_call` items.
3. When the turn ends, split calls into **read-only** (run via `Promise.all`)
   and **mutating** (sequential, each harness-gated) groups.
4. Feed `function_call_output` items back; repeat until no tool calls.
5. Cap loop iterations (`maxToolIterations`, default 16); feed tool errors back
   so the model can self-correct.

### Permission model

Declarative, harness-enforced. A policy maps tool names to `allow` / `deny` /
`ask`. Three modes:

- `interactive` (default): read-only auto-allowed; mutating prompts `y/n/a`.
- `auto`: mutating auto-approved.
- `plan`: mutating denied; read-only only.

`a` (always) approves a single tool for the rest of the session (cleared by
`/reset`); it never persists to disk.

## 6. Locked decisions

| # | Topic | Decision |
|---|-------|----------|
| A | Config format | JSON (zero extra deps) |
| B | History | Capped in-memory array (`maxHistoryItems`); `/reset` drops, `/clear` screen-only |
| C | Shell model | Real shell (`/bin/sh -c`), harness-gated, cwd-confined |
| D | Loop term | Cap (16, configurable) + feed tool errors back as `function_call_output` |
| E | `always` scope | Per-tool, session-scoped (cleared by `/reset`) |
| F | Result size | Truncate to `maxToolOutputBytes` (32 KB) + note |
| G | Workdir | CWD, `--cwd` override; git via `git -C <cwd>` |
| H | Injection | Pass through raw, documented as untrusted |
| I | MCP life | Spawn at startup, session-lived, close on exit/SIGINT |
| J | Persistence | Ephemeral v1 (in-session up/down only) |
| K | bin | `bin: dcode -> src/index.ts`, shebang, engines >=26 |
| L | Cancel | Ctrl-C aborts stream + SIGTERMs shell child, returns to prompt |

## 7. CLI surface

```
dcode [prompt]      one-shot when a prompt is given, REPL otherwise
  --model <id>       --mode <interactive|auto|plan> --auto (=auto) --plan (=plan)
  --config <path>    --no-stream   --verbose   --no-color   --version   --help
```

Slash commands (REPL), registered incrementally: `/help` `/model` `/mode`
`/clear` `/reset` `/tools` `/version` `/exit`.

## 8. Phase plan

| Phase | Scope | Status |
|-------|-------|--------|
| P0 | Scaffold & tooling (this document set) | **Done** |
| P1 | Config + OpenAI client + one-shot (no tools) | **Done** |
| P2 | REPL + slash commands + streaming in REPL | **Done** |
| P3 | Tool core + read-only tools + async loop (parallel read-only) | |
| P4 | Mutating local tools (write/edit/shell/git) | |
| P5 | Declarative permissions + modes | |
| P6 | MCP integration | |
| P7 | Polish (verbose/stderr, --no-color, SIGINT, docs pass) | |

## 9. Testing strategy

- Tests live in `tests/`, mirroring `src/` (`tests/cli/args.test.ts` -> `src/cli/args.ts`).
- Prefer fast, deterministic unit tests over network integration.
- Mock external boundaries (OpenAI client, `child_process`, `fs` side effects).
- For colored output, assert against `ansis.strip(...)`.
- `tsc --noEmit` and `pnpm format:check` gate every commit.

## 10. P2 Specification (REPL)

Status: **Done**. This section is the authoritative P2 design; it was implemented
as code + tests + docs in one focused commit.

### 10.1 Scope
Make `dcode` interactive: a REPL when no prompt is given, streaming model output,
and slash commands. **Out of scope for P2:** tools, permissions, MCP (P3+). P2 must
(a) make `dcode` interactive, (b) establish multi-turn history, and (c) lay a clean
foundation so P3's loop slots in without rework.

### 10.2 Module changes

**`src/agent/run.ts` — turn runner.**
- `runTurn(client, config, input: ResponseInput, sink, logger, signal?): Promise<string>`.
  Picks `complete` vs `stream` from `config.stream`, writes deltas / full text to
  `sink`, returns the full text, and forwards `signal` (decision L). Used by the REPL
  and the future P3 agent loop.
- `runOneShot(client, config, prompt, sink, logger)` is **self-contained**: it builds
  `[system, user]` and runs the turn inline. It does **not** delegate to `runTurn`.
- P3 will add `runTool(input)` — the per-tool execution primitive (policy-gated in
  P5) — to this same module, so agent execution is centralized in `agent/run.ts`.

**`src/cli/repl.ts` (new) — `startRepl(config, logger)`.**
Keep it thin and testable by splitting into:
- A module-local `ReplSession` = `{ config, client, logger, history: ResponseInput }`,
  where `history[0]` is the system message from `buildSystemPrompt(config)`.
- `handleLine(session, line): Promise<void>` — the core: parse command vs prompt,
  dispatch or run a turn, append to history, trim.
- `startRepl` — thin `readline` wiring that feeds lines into `handleLine` and writes
  the prompt. Each turn shows a persistent hint (`Ask anything, /help for
  commands...`) above a `>` prompt.
Session state lives **module-local in `repl.ts`** (per decision); P3's
`agent/loop.ts` will own the turn loop and reuse `runTurn`.

**`src/index.ts`** — replace the "REPL arrives in phase 2" placeholder with
`await startRepl(config, logger)`.

### 10.3 Slash commands
P2 set: `/help`, `/model [<id>]`, `/clear`, `/reset`, `/version`, `/exit`.
- `/clear` — screen-only (decision B): `console.clear()` / ANSI clear; history
  untouched.
- `/reset` — history back to `[system]`; clears in-session `always` (none yet; P5).
- `/model` — with `<id>` updates `config.model` for subsequent turns (in-session
  only; decision J ephemeral); with no argument prints the current model.
- `/version` — `dcode v{getVersion()}`.
- **Deferred:** `/mode` → P5 (permissions, inert without tools); `/tools` → P3 (no
  tools to list yet).

### 10.4 Streaming, history, cancel, errors
- **History cap (decision B):** `trimHistory(history, config.maxHistoryItems)` keeps
  `history[0]` (system) and the last N items; trims oldest user/assistant. Stored as
  a plain `ResponseInput` array, so P3 tool-call / tool-output items drop in later.
- **Ctrl-C (decision L):** `readline` `'SIGINT'` aborts the in-flight
  `AbortController` → `runTurn`'s signal → stream aborts → caught, logged
  `[warn] aborted`, returns to prompt. Process must NOT exit. (Shell-child SIGTERM is
  P4.)
- **Per-turn errors:** caught per turn, `logger.error(...)`, session continues
  (one-shot exits; REPL does not).
- **`--no-stream`:** respected in REPL via `config.stream`.

### 10.5 Output / color
Streamed model text → `process.stdout` (reserved channel). REPL prompt colored via
`ansis`. Rendering stays minimal in P2 (no `ui/render.ts` TUI); that module earns its
place at P3 for tool-status lines. A tiny `ui/prompt.ts` for the prompt string is
optional.

### 10.6 Multi-line input
Deferred to a later phase (single-line in P2).

### 10.7 Tests (`tests/cli/repl.test.ts`)
Mirror the split so `readline` I/O is the only untested seam:
- Pure / fast: `parseCommand`, `trimHistory` (cap behavior), `dispatch` for
  `/model` / `/reset` / `/clear` (assert session state + returned strings).
- Smoke: mock `node:readline` (`vi.mock`) to emit `'line'` events; assert streamed
  output + command effects using a `fakeClient` like the existing run tests.
- Keep `run.test.ts` green (don't break `runOneShot` signature).

### 10.8 Files touched
- New: `src/cli/repl.ts`, `tests/cli/repl.test.ts`
- Modify: `src/agent/run.ts` (add `runTurn`), `src/index.ts` (call `startRepl`)
- Optional: `src/ui/prompt.ts`
- Docs after merge: this section (mark P2 done), CHANGELOG (Unreleased → Added:
  REPL), README (REPL usage)
