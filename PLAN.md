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
  agent/client.ts     # wraps OpenAI Responses API (streaming)
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
| G | Workdir | `root` (config field, defaults to process cwd); git via `git -C <root>` |
| H | Injection | Pass through raw, documented as untrusted |
| I | MCP life | Spawn at startup, session-lived, close on exit/SIGINT |
| J | Persistence | Ephemeral v1 (in-session up/down only) |
| K | bin | `bin: dcode -> src/index.ts`, shebang, engines >=26 |
| L | Cancel | Ctrl-C aborts stream + SIGTERMs shell child, returns to prompt |

## 7. CLI surface

```
dcode [prompt]      one-shot when a prompt is given, REPL otherwise
  --model <id>       --mode <interactive|auto|plan> --auto (=auto) --plan (=plan)
  --config <path>    --verbose   --no-color   --version   --help
```

Slash commands (REPL), registered incrementally: `/help` `/model` `/mode`
`/clear` `/reset` `/tools` `/version` `/exit`.

## 8. Phase plan

| Phase | Scope | Status |
|-------|-------|--------|
| P0 | Scaffold & tooling (this document set) | **Done** |
| P1 | Config + OpenAI client + one-shot (no tools) | **Done** |
| P2 | REPL + slash commands + streaming in REPL | **Done** |
| P3 | Tool core + read-only tools + async loop (parallel read-only) | **Done** |
| P4 | Mutating local tools (write_file/edit_file/run_shell) + harness gate | **Specified** — see §12 |
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

**`src/agent/run.ts` — universal turn runner.**
- Add `runTurn(client, config, input: ResponseInput, sink, logger): Promise<string>`.
  Streams deltas to `sink` from `runTurn`, writes streamed text to `sink`, returns
  the full text, and forwards `opts.signal` (decision L).
- `runOneShot(client, config, prompt, sink, logger)` becomes a thin wrapper that
  builds `[system, user]` and calls `runTurn`. Existing `run.test.ts` stays green.
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

## 11. P3 Specification (Tool core + read-only tools + async loop) — implemented

Status: **Specified** — implementation pending. This section is the authoritative
P3 design, grounded in research of the OpenAI Responses API and the `openai-node`
SDK (`client.responses.stream(...)`). Implement it as code + tests + docs + a
focused commit.

### 11.1 Scope
- **In:** tool types + registry, zod→JSON-schema conversion, three read-only
  tools (`read_file`, `list_dir`, `grep`), the async agent loop (parallel
  read-only execution, capped, error-fed), tool-status rendering, and the
  `/tools` command (deferred from P2).
- **Out:** mutating tools (`write_file`/`edit_file`/`shell`/`git`) → P4;
  permission policy/harness (`y/n/a`) → P5; MCP → P6.

### 11.2 SDK basis (research findings)
- `client.responses.stream(params)` returns a `ResponseStream` (an
  `AsyncIterable` of `ResponseStreamEvent`).
- Key events: `response.output_text.delta` (`.delta` = text fragment),
  `response.output_item.done` whose `item.type === 'function_call'` carries
  `call_id`, `name`, `arguments` (JSON string), and terminal
  `response.completed` / `response.failed` / `response.incomplete`.
- `stream.finalResponse(): Promise<Response>` returns the accumulated response;
  its `.output` array holds the `function_call` items. Known caveat
  (openai-node #1662): `finalResponse().output_text` was historically `undefined`
  on streamed responses — **irrelevant here** because we accumulate text from the
  deltas.
- `tools` is `OpenAI.Responses.Tool[]` =
  `{ type: 'function', name, description, parameters: <JSON Schema>, strict? }`.
  The Responses API wants **JSON Schema**, not zod — so the registry converts.
- Official loop (Responses API guides): iterate the stream, render text deltas,
  collect `function_call` items, append one `function_call_output`
  (`{ type: 'function_call_output', call_id, output }`) per call to `input`,
  re-request, stop when no calls, cap iterations, handle terminal events.

### 11.3 Module changes
- **`agent/loop.ts` (new) — `runAgent(client, config, input, sink, logger, signal?)`.**
  Owns the iterative tool loop; reuses `runTurn` (single model turn) and `runTool`
  (single tool exec). Grows `history` (a `ResponseInput`) with output + output
  items and feeds `function_call_output` back (decision B).
- **`agent/run.ts`.** `runTurn` now returns `{ text: string, response: Response }`
  and still streams deltas to `sink`. Add `runTool(call, config, logger)`:
  registry lookup → zod parse → execute → truncate (decision F) → wrap as
  `function_call_output`. (`runOneShot` keeps returning just `text` for tool-less
  one-shots.)
- **`agent/types.ts` (new).** `Tool`, `ToolCall`, `ToolContext`, `ToolResult`.
- **`tools/registry.ts` (new).** `register`/`get`/`list` + `toResponsesTool(tool)`
  (zod → JSON Schema). Returns `OpenAI.Responses.Tool[]` for the client.
- **`tools/local/fs.ts` (new).** `read_file`, `list_dir`, `grep`; path-confined
  to `config.root`.
- **`ui/render.ts` (new).** `renderToolResult(name, ok, ms)` → status lines.
- **`cli/repl.ts`.** Add `/tools` dispatch (lists registered tools).
- **`agent/client.ts`.** `stream` gains `tools?` and returns `ModelStream` (below).

### 11.4 Client contract
```ts
export interface ModelStream extends AsyncIterable<string> {
  finalResponse(): Promise<Response>
}
export interface Client {
  stream(
    input: ResponseInput,
    opts?: { tools?: OpenAI.Responses.Tool[]; signal?: AbortSignal },
  ): ModelStream
}
```
Internally the wrapper iterates the SDK event stream, yields
`response.output_text.delta.delta` for rendering, and lets `finalResponse()`
return the accumulated `Response` (with `.output` tool calls). This keeps the
string-based `sink.write(delta)` seam intact (Option B; the event-driven Option A
is an alternative but more churn).

### 11.5 Loop algorithm
1. `while iteration++ < config.maxToolIterations:` call `runTurn(client, config, history, …)`.
2. Push the assistant `output` items onto `history`.
3. `calls = response.output.filter(function_call)`; if none, break (final text
   already streamed).
4. `results = await Promise.all(calls.map(c => runTool(c, config, logger)))` —
   P3 tools are all read-only, so run in parallel; the read-only/mutating split
   (parallel vs sequential, harness-gated) is added in **P4**.
5. Push `results` (`function_call_output`) onto `history`; repeat.
- Tool **errors** return *as* `function_call_output` (decision D) so the model
  self-corrects; the loop never throws on a tool failure.
- `maxToolIterations` default 16 (decision D); `toolTimeout` (currently unused)
  gates each `runTool` execution in P3.
- Path confinement: tools resolve against `config.root` and reject traversal
  outside (decision G/H). (§6 G updated to name the `root` field.)

### 11.6 Tool interface & registry
```ts
export interface ToolContext { root: string; config: AppConfig; logger: Logger }
export interface Tool {
  name: string
  description: string
  parameters: z.ZodType
  execute(args: unknown, ctx: ToolContext): Promise<string>
}
export interface ToolCall { id: string; name: string; arguments: string }
```
`toResponsesTool` converts `parameters` (zod) → JSON Schema for
`OpenAI.Responses.Tool`. **Decision: hand-roll** a minimal converter (no new
dependency). Use **`strict: false`** on the generated schemas.

### 11.7 Read-only tools
- `read_file(path)` — read a file under `root`; reject escapes.
- `list_dir(path)` — list a directory under `root`.
- `grep(pattern, path?)` — search file contents under `root`.
All results truncated to `config.maxToolOutputBytes` with a note (decision F).
Tool output is untrusted data (decision H).

### 11.8 Output (`ui/render.ts`)
`renderToolResult(name, ok, ms)` → `› read_file: src/index.ts ✓ done (0.0s)`
(color via `ansis`, same auto-TTY behavior as today). Printed between turns,
before the next streamed model text — matching the REPL layout.

### 11.9 Slash commands
`/tools` — list registered tools (`name` + `description`); deferred from P2 to P3.

### 11.10 Tests (`tests/agent/loop.test.ts`, `tests/tools/*`)
- `types`/`registry`: register/list/get, zod→JSON conversion.
- `fs`: mock `fs`, assert content + path-confinement rejection.
- `runTool`: truncation (F), error-as-output (D), timeout.
- `loop`: `fakeClient` whose `stream` yields text and `finalResponse()` returns a
  canned `Response` with a `function_call`; assert tools run, outputs fed back,
  loop terminates, `maxToolIterations` cap honored, history grows with tool
  items.
- `render`: assert formatted lines via `ansis.strip(...)`.

### 11.11 Files touched
- New: `src/agent/loop.ts`, `src/agent/types.ts`, `src/tools/registry.ts`,
  `src/tools/local/fs.ts`, `src/ui/render.ts`, `tests/agent/loop.test.ts`,
  `tests/tools/*`.
- Modify: `src/agent/run.ts` (`runTurn` return + `runTool`), `src/agent/client.ts`
  (`stream` → `ModelStream` + `tools`), `src/cli/repl.ts` (`/tools`),
  `src/index.ts` (wire `runAgent` when tools are registered).
-   Docs after merge: this section (mark P3 done; §6 G already updated to `root`),
  CHANGELOG (Unreleased → Added: tools/loop), README (tools overview).

### 11.12 Resolved decisions
1. **zod→JSON Schema:** hand-roll a minimal converter (no new dependency).
2. **`strict: false`** on tool schemas.
3. **Workdir confinement uses `config.root`** (the actual schema field); §6 G's
   `--cwd` wording updated to `root`.
4. **`toolTimeout`** is applied as the per-tool execution timeout inside `runTool`.
5. **`Client.stream` shape: Option B** (string stream + `finalResponse()`, minimal
    churn; the event-driven Option A is not used).

## 12. P4 Specification (Mutating local tools + harness gate)

Builds on P3 (decisions B/D/F/G/H unchanged). Adds tools that change state and
the machinery to run them **sequentially** and **only after harness approval**
— the read-only/mutating split deferred from §11.5. Full declarative permissions
(modes + rule tables) stay in P5; P4 defines the *gate seam* P5 plugs into.

### 12.1 Scope
- New mutating tools: `write_file`, `edit_file`, `run_shell` (git is reached via
  `run_shell`, not a dedicated tool).
- Loop change: separate read-only (parallel) from mutating (sequential, gated)
  calls within a turn.
- A minimal harness gate so mutating calls are approved (REPL prompt) or denied
  (one-shot) by default. P5 later supplies a config-driven gate.
- Out of scope: `delete_file`/`move_file`, undo/backup, declarative permissions.

### 12.2 SDK basis
Reuses §11.2 — `client.responses.stream`, `finalResponse().output` tool-call
extraction, JSON-Schema `tools` param. No new SDK surface.

### 12.3 Module changes
- `src/agent/types.ts`: `Tool` gains `mutates?: boolean` (default `false`).
- `src/agent/loop.ts`: `runAgent` opts gain
  `gate?: (tool: Tool, call: ToolCall) => Promise<boolean>`; the per-turn call
  list is split into read-only (parallel) and mutating (sequential + gated).
- `src/tools/local/mutate.ts` (new): `write_file`, `edit_file`, `run_shell`.
- `src/tools/index.ts`: register mutating tools alongside read-only ones.
- `src/agent/gate.ts` (new): REPL confirmation prompt with `y`/`n`/`a`
  (always-for-session) state; one-shot uses a gate that denies mutating.
- `src/cli/repl.ts` + `src/cli/commands.ts`: build/thread the gate; `/tools`
  annotates mutating tools.
- `src/ui/render.ts`: reuse `renderToolResult` (no change needed).

### 12.4 Tool interface & gate
```ts
export interface Tool {
  name: string
  description: string
  parameters: z.ZodType
  execute(args: unknown, ctx: ToolContext): Promise<string>
  mutates?: boolean // default false → read-only, parallel, ungated
}
```
`gate: (tool: Tool, call: ToolCall) => Promise<boolean>` is supplied by the
harness. `runAgent` calls it before any mutating `runTool`; a `false` result
yields an `ok:false` outcome with output `"denied by user"` (decision D), fed
back as `function_call_output` so the model self-corrects.

### 12.5 Loop algorithm
1. `while iteration++ < config.maxToolIterations:` call `runTurn` (decision D).
2. Push the assistant `output` items onto `history` (decision B).
3. `calls = response.output.filter(function_call)`; if none, break.
4. Split `calls` into `reads` (`!tool.mutates`) and `mutates` (`tool.mutates`).
5. `results = await Promise.all(reads.map(c => runTool(c, ...)))` — parallel.
6. For each `m` in `mutates` (in order):
   - if `gate(tool, m)` is false → push a denied `function_call_output`.
   - else `outcome = await runTool(m, ...)` (sequential).
   - push `outcome` as `function_call_output`; render between turns.
7. Repeat.

### 12.6 Mutating tools
- `write_file(path, content)` — create/overwrite a file under `root`
  (`resolvePath`, decision G); `content` may be large (truncated, decision F).
- `edit_file(path, old_string, new_string, replace_all?)` — literal string
  replace (no diff parser, no new dependency). Error if `old_string` is absent,
  or present more than once without `replace_all`.
- `run_shell(command)` — spawn under `cwd = root` (decision G), capture merged
  stdout/stderr, apply `toolTimeout`, truncate to `maxToolOutputBytes`. Full
  arbitrary shell, gated.

### 12.7 Output (`ui/render.ts`)
Reuses `renderToolResult` (`› write_file: ✓ done (0.0s)`); color via `ansis`,
same auto-TTY behavior as P3. No change.

### 12.8 Slash commands
`/tools` annotates mutating entries (e.g. `write_file *`). No new commands.

### 12.9 Tests (`tests/tools/mutate.test.ts`, `tests/agent/loop.test.ts`)
- `mutate`: `write_file` writes; `edit_file` replaces / errors on missing or
  ambiguous match; `run_shell` runs under `root` + honors `toolTimeout`;
  path-escape rejected (reuse fs tests pattern).
- `loop`: mutating calls execute **sequentially** (asserted order); a gated
  `false` yields a `denied by user` `function_call_output`; read-only calls in
  the same turn run in parallel; loop still caps at `maxToolIterations`.

### 12.10 Files touched
- New: `src/tools/local/mutate.ts`, `src/agent/gate.ts`, `tests/tools/mutate.test.ts`.
- Modify: `src/agent/types.ts` (`mutates`), `src/agent/loop.ts` (grouping +
  gate), `src/tools/index.ts` (register), `src/cli/repl.ts` + `src/cli/commands.ts`
  (prompt gate, `/tools`), `tests/agent/loop.test.ts`.
- Docs after merge: this section (mark P4 done), README (mutating tools +
  gating note), CHANGELOG (Unreleased → Added: P4 tools/gate).

### 12.11 Resolved decisions
1. **Tool set:** `write_file` + `edit_file` + `run_shell` (git via `run_shell`).
2. **`edit_file` semantics:** literal old/new string replace; no diff parser.
3. **One-shot default:** deny mutating calls (safe default; P5 `--mode auto` changes it).
4. **Shell scope:** full arbitrary shell, gated + `cwd=root` + `toolTimeout`.
5. **Ordering:** reads parallel, then mutating sequential (in model emission order).
6. **Undo/backup:** out of scope for P4.
