# PLAN.md — dcode

Product Requirements Document for **dcode**, a CLI-based AI coding agent built on
the OpenAI Responses SDK.

Status: **P10 complete** (context-window management). The tool-permission
architecture (harness gate + P5 modes/rules) was **removed** on the `experiment`
branch — every tool call now runs unconditionally. Phases advance one at a time;
each lands as code + tests + docs + a focused commit.
This document is the source of truth for features, architecture, and
conventions — keep it in sync after every phase.

## 1. Vision

A small, modular, locally-run coding agent you drive from a terminal:

- One-shot: `dcode "add a CLI flag to parse --verbose"`
- REPL: `dcode` then chat, with slash commands.
- Uses local system tools (files, shell, git) and optional MCP servers.
- Fully async agent loop; tool calls run in emission order.
- Streaming model output, configurable models.

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
  cli/repl.ts         # readline loop; builds the Session and drives runAgent
  cli/commands.ts     # Session type, parseCommand/dispatch for slash commands
  config/schema.ts    # zod schema (Config), .strict()
  config/config.ts    # loadConfig(path) + mergeConfigs(CLI, file, env) + resolveRoot
  agent/client.ts     # wraps OpenAI Responses API (streaming); ModelStream
  agent/system.ts     # buildSystemPrompt(config)
  agent/run.ts        # runTurn (one model turn) + runTool (one tool call, timeout+truncate)
  agent/loop.ts       # runAgent: tool-calling loop; runOneShot wraps it for one-shot
  agent/context/      # context-window management (P10):
                      #   tokens.ts  (cheap ~4c/tok estimate, calibrated by real usage)
                      #   prune.ts   (collapse old tool outputs to a marker)
                      #   compact.ts (summarize oldest history via a model call)
                      #   manager.ts (ContextManager: prune→compact, overflow retry, breaker)
  agent/types.ts      # ToolDefinition<P>, ToolContext, ToolCall, ToolResult
  agent/tasks.ts      # TaskStore: in-session task list (create/list/update)
  tools/index.ts      # createLocalTools(tasks): hub that registers all local tools into the registry
  tools/registry.ts   # ToolRegistry: register/list/get (built once; toResponsesTools memoized); zod->JSON-schema via z.toJSONSchema
   tools/local/        # local tool set, split by concern:
                        #   paths.ts   (resolvePath, fsError — path confinement)
                        #   traverse.ts (walkDir, globToRegExp)
   #   fs.ts      (read_file, list_dir, stat, write_file, edit_file,
   #               move_file, copy_file, delete_file, make_dir)
   #   process.ts (run_process, read_process, kill_process — background)
   #   search.ts  (grep, glob, find_symbol, find_references)
   #   patch.ts   (apply_patch — atomic multi-file unified-diff apply)
                        #   shell.ts   (run_shell)
   tools/index.ts      # createLocalTools: assembles local + web + todo into a ToolRegistry
   tools/local/web.ts  # web_search (Brave Search API; key from BRAVE_API_KEY)
  tools/local/todo.ts # todo (single tool over TaskStore: add/list/update/done)
  tools/local/git.ts  # git: scoped status/diff/log/show/add/commit/branch
   tools/mcp/manager.ts# connect servers, cache tools, callTool (P6)
   agent/loop.ts       # orchestration; renders tool status lines inline
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

**Removed.** On the `experiment` branch the harness gate and the P5
modes/rules design were deleted; `src/agent/gate.ts` is gone, `ToolDefinition`
has no `mutates` flag, and `runCalls` executes every tool call unconditionally in
the order the model emitted it. There is no approval prompt and no `--mode` /
`--auto` / `--plan` flags. See §13 for the cancelled design.

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
  --model <id>       --config <path>    --verbose   --no-color   --version   --help
```

Slash commands (REPL): `/help` `/key` `/model` `/tools` `/clear` `/reset`
`/compact` `/context` `/tasks` `/config` `/undo` `/verbose` `/version` `/exit`.
See §17 for deferred candidates.

## 8. Phase plan

| Phase | Scope | Status |
|-------|-------|--------|
| P0 | Scaffold & tooling (this document set) | **Done** |
| P1 | Config + OpenAI client + one-shot (no tools) | **Done** |
| P2 | REPL + slash commands + streaming in REPL | **Done** |
| P3 | Tool core + read-only tools + async loop (parallel read-only) | **Done** |
 | P4 | Mutating local tools (write_file/edit_file/run_shell) | **Done** — see §12 |
 | P5 | Declarative permissions + modes | **Cancelled** (removed on `experiment`) |
| P6 | MCP integration | |
 | P7 | Polish (verbose/stderr, --no-color, SIGINT, docs pass) | **Done** |
| P8 | Task list (in-session: create/list/update) | **Done** |
| P9 | Git tool (scoped status/diff/log/show/add/commit/branch) | **Done** |
| P10 | Context-window management (prune + compact + overflow retry) | **Done** |
| P11 | File lifecycle (move/copy/delete/mkdir) + background process tools | **Done** (see §19) |
| P12 | Symbol search (`find_symbol` / `find_references`, ripgrep-lite) | **Planned** (see §20) |
| P13 | `apply_patch` (atomic multi-file unified-diff apply) | **Planned** (see §21) |

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
`ansis`. Rendering stays minimal; tool-status lines are rendered inline in
`agent/loop.ts` (no separate `ui` module). A tiny `ui/prompt.ts` for the prompt
string is optional.

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

Status: **Done**. This section is the authoritative P3 design, grounded in
research of the OpenAI Responses API and the `openai-node` SDK
(`client.responses.stream(...)`); it was implemented as code + tests + docs
across several focused commits. A few implementation details evolved past
what's written below — see §11.12.

### 11.1 Scope
- **In:** tool types + registry, zod→JSON-schema conversion, three read-only
  tools (`read_file`, `list_dir`, `grep`, `stat`, `glob`), the async agent loop (parallel
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
  and still streams deltas to `sink`.   Add `runTool(tool, raw, config)`:
  registry lookup → zod parse → execute → truncate (decision F) → wrap as
  `function_call_output`. (`runOneShot` keeps returning just `text` for tool-less
  one-shots.)
- **`agent/types.ts` (new).** `ToolDefinition<P>`, `ToolCall`, `ToolContext`, `ToolResult`.
- **`tools/registry.ts` (new).** `register`/`get`/`list` + `toResponsesTool(tool)`
  (zod → JSON Schema). Returns `OpenAI.Responses.Tool[]` for the client.
- **`tools/local/fs.ts` (new).** `read_file`, `list_dir`, `grep`, `stat`, `glob`; path-confined
  to `config.root`.
- **`agent/loop.ts`.** Renders tool status lines inline via `renderToolResult(name, ok, ms)`.
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
4. `results = await Promise.all(calls.map(c => runTool(tool, c.arguments, config)))` —
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
export interface ToolContext { root: string; config: Config; logger: Logger }
export interface ToolDefinition {
  name: string
  description: string
  parameters: z.ZodType
  execute(args: unknown, ctx: ToolContext): Promise<string>
}
export interface ToolCall { id: string; name: string; arguments: string }
```
`toResponsesTool` converts `parameters` (zod) → JSON Schema for
`OpenAI.Responses.Tool` via zod v4's built-in `z.toJSONSchema` (superseding
the hand-rolled converter this section originally specified — see §11.12).
Use **`strict: false`** on the generated schemas.

### 11.7 Read-only tools
- `read_file(path)` — read a file under `root`; reject escapes.
- `list_dir(path)` — list a directory under `root`.
- `grep(pattern, path?)` — search file contents under `root`.
- `stat(path?)` — report type/size/mtime of a file or directory under `root`.
- `glob(pattern)` — list files matching a glob pattern (`**` recursive) under `root`.
All results truncated to `config.maxToolOutputBytes` with a note (decision F).
Tool output is untrusted data (decision H).

### 11.8 Output (`agent/loop.ts`)
`renderToolResult(name, ok, ms)` → `› read_file: src/index.ts ✓ done (0.0s)`
(color via `ansis`, same auto-TTY behavior as today). Printed between turns,
before the next streamed model text — matching the REPL layout. The helper
lives inline in `agent/loop.ts` (its only consumer).

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
  `src/tools/local/fs.ts`, `tests/agent/loop.test.ts`, `tests/tools/*`.
  (Tool-status rendering lives inline in `agent/loop.ts`, not a separate
  `ui/render.ts`.)
- Modify: `src/agent/run.ts` (`runTurn` return + `runTool`), `src/agent/client.ts`
  (`stream` → `ModelStream` + `tools`), `src/cli/repl.ts` (`/tools`),
  `src/index.ts` (wire `runAgent` when tools are registered).
-   Docs after merge: this section (mark P3 done; §6 G already updated to `root`),
  CHANGELOG (Unreleased → Added: tools/loop), README (tools overview).

### 11.12 Resolved decisions
1. **zod→JSON Schema:** originally hand-rolled (no new dependency); later
   switched to zod v4's built-in `z.toJSONSchema`, which emits a compatible
   JSON Schema (draft 2020-12) and removed the need to maintain a converter.
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
- `src/agent/types.ts`: `ToolDefinition` gains `mutates?: boolean` (default `false`).
- `src/agent/loop.ts`: `runAgent` opts gain
  `gate?: (tool: ToolDefinition, call: ToolCall) => Promise<boolean>`; the per-turn call
  list is split into read-only (parallel) and mutating (sequential + gated).
- `src/tools/local/mutate.ts` (new): `write_file`, `edit_file`, `run_shell`.
- `src/tools/index.ts`: register mutating tools alongside read-only ones.
- `src/agent/gate.ts` (new): REPL confirmation prompt with `y`/`n`/`a`
  (always-for-session) state; one-shot uses a gate that denies mutating.
- `src/cli/repl.ts` + `src/cli/commands.ts`: build/thread the gate; `/tools`
  annotates mutating tools.
- `src/agent/loop.ts`: reuse `renderToolResult` (no change needed).

### 12.4 Tool interface & gate
```ts
export interface ToolDefinition {
  name: string
  description: string
  parameters: z.ZodType
  execute(args: unknown, ctx: ToolContext): Promise<string>
  mutates?: boolean // default false → read-only, parallel, ungated
}
```
`gate: (tool: ToolDefinition, call: ToolCall) => Promise<boolean>` is supplied by the
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

### 12.7 Output (`agent/loop.ts`)
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

### 12.12 Status
**Done.** `write_file`/`edit_file`/`run_shell` live in `src/tools/local/mutate.ts`
(exporting `resolvePath` from `fs.ts`); the harness gate (`src/agent/gate.ts`)
defaults to deny (one-shot) and prompts `y/n/a` in the REPL. `runAgent` splits
read-only calls (parallel) from mutating ones (sequential, each gated), keeping
original call order in history. `Session` carries the gate; `/tools` annotates
mutating entries with ` *`. Covered by `tests/tools/mutate.test.ts` and loop
gating/ordering tests.

> **Note:** the harness gate described above was removed on the `experiment`
> branch — `src/agent/gate.ts` deleted, `mutates` flag dropped, and `runCalls`
> now executes every call unconditionally (see §5). P4's mutating *tools* remain;
> only the approval step is gone. The two tool-definition files
> (`tools/local/fs.ts`, `tools/local/mutate.ts`) were also unified into a single
> `src/tools/local.ts`, then split again by concern (`paths.ts`, `traverse.ts`,
> `fs.ts`, `search.ts`, `shell.ts`, `index.ts`), with `tools/index.ts` as the one
> hub that registers the `localTools` array into the `ToolRegistry`.
>
> **Future (not yet built):** all tool calls now run sequentially in emission
> order, so read-only calls no longer run in parallel (the old `mutates` split
> was removed with the gate). To restore parallel reads *without* reviving the
> permission model, add a `parallel?: boolean` flag to `ToolDefinition` (default
> `true`; `false` for `write_file`/`edit_file`/`run_shell`) and have `runCalls`
> batch the parallelizable calls via `Promise.all` while running the rest
> sequentially in emission order. Scheduling hint only — never approval.

## 13. P5 Specification (Declarative permissions + modes) — cancelled

Builds on the P4 gate seam (`src/agent/gate.ts`). Plugs a declarative policy
(`config.permissions`, already in `config/schema.ts`) into the `Gate` so tool
calls are resolved by mode + rules instead of a fixed deny/confirm behavior.
**Inspired by** Claude Code (tiered mode/rules, first-match
deny→ask→allow, deny strongest, `dontAsk` for CI), OpenCode (tool-keyed
`permission` with wildcards), and Pi (capability-based "tool doesn't exist" as
the strongest guarantee — applied here as hiding denied tools from the model).

### 13.1 Scope
- Declarative policy evaluation: `evaluate(tool, call, mode, rules, session) ->
  'allow' | 'deny' | 'ask'`.
- Four modes: `interactive` (default), `auto`, `plan`, `dontAsk`.
- Per-tool rules (`allow`/`deny`/`ask`) keyed by exact tool name plus a single
  `*` wildcard; no argument/command specifiers in P5.
- Wire the policy into the existing `Gate` at the REPL and one-shot call sites;
  add `/mode` command and make `/reset` also clear in-session approvals.
- In-session `a` (always) approval is per-tool and session-scoped.

### 13.2 Locked decisions (from research review)
1. **Rule keys** — exact tool name (`write_file`, `run_shell`, …) plus a `*`
   catch-all. No path/command specifiers this phase (tool-level only).
2. **`a` scope** — per-tool (only that tool, rest of session), cleared by
   `/reset`. Matches decision E; not durable/project-scoped.
3. **Rules beat mode** — an explicit rule always wins over the mode baseline.
   A `deny` rule blocks even in `auto`/`dontAsk`. (Claude Code: "Deny rules
   block in every mode, including `bypassPermissions`.")
4. **`ask` with no TTY** — resolves to **deny** (one-shot/piped has no prompt).
   One-shot therefore behaves like `dontAsk`: only `allow` rules / `auto` mode
   let mutating calls through.
5. **`/mode` persistence** — in-session only (ephemeral, like `a`); config files
   stay user-edited.
6. **Argument-aware rules** — out of scope for P5 (tool-level only).
7. **`deny` can block reads** — a `deny` rule is honored for any tool (incl.
   read-only); `allow`/`ask` on a read-only tool are no-ops since reads are
   already allowed.
8. **`dontAsk` mode (new)** — deny anything not explicitly `allow`; `ask` rules
   become denials rather than prompts. The mode for one-shot / CI.
9. **Hide denied tools** — when a tool is `deny`-ruled, also drop it from the
   Responses tool list sent to the model (Pi's "incapable" idea, applied
   surgically). Read-only tools stay available unless explicitly denied.

### 13.3 Evaluation algorithm (`evaluate`)
Order, per tool call:
1. **Explicit rule** for the tool name (or `*`): if `deny` → `deny`; if `ask` →
   `ask`; if `allow` → `allow`. First match wins; specificity does not reorder.
2. **No rule** → mode baseline:
   - `interactive` → `ask` (for mutating); reads → `allow`.
   - `auto` → `allow` (mutating included); reads → `allow`.
   - `plan` → `deny` (mutating); reads → `allow`.
   - `dontAsk` → `deny` (mutating and anything not explicitly allowed);
     reads → `allow` unless a `deny` rule says otherwise.
3. **In-session `a`** — a prior `a` on this tool upgrades the result to `allow`
   for the rest of the session (does not override an explicit `deny` rule).
Read-only tools (`read_file`, `list_dir`, `grep`, `stat`, `glob`) short-circuit
to `allow` before step 1 unless a `deny` rule targets them (decision 7).

### 13.4 Module changes
- `permissions/policy.ts` (new): pure `evaluate(...)` + `resolveGate(ctx)` that
  returns a `Gate` from `(config, sessionState, ask)`.
- `permissions/harness.ts` (new): glue — `evaluate` → `allow`⇒`true`,
  `deny`⇒`false`, `ask`⇒ injected `askPermission` (REPL) → `y`/`a`⇒`true`,
  `n`⇒`false`; `a` records per-tool session approval. Used by both REPL and
  one-shot; one-shot injects an `ask` that returns `n`.
- `ui/prompt.ts` (new): `askPermission(tool, call): Promise<'y'|'n'|'a'>`
  (REPL wires to readline; one-shot injects a no-op returning `n`).
- `src/tools/registry.ts` or `src/agent/loop.ts`: filter `toResponsesTools()`
  to exclude tools whose policy resolves to `deny` for the active session
  (decision 9).
- `src/cli/repl.ts` / `src/cli/commands.ts`: build the policy gate; add `/mode`
  (get/set `session.config.permissions.mode`); `/reset` clears in-session
  approvals. `Session` gains `approvals: Set<string>`.
- `src/agent/loop.ts` / `src/index.ts`: pass the policy gate (not the P4
  deny/confirm gates) into `runAgent` / `runOneShot`.

### 13.5 Slash commands
- `/mode` — print current mode; `/mode <interactive|auto|plan|dontAsk>` sets it
  in-session.
- `/reset` — history back to `[system]` **and** clears in-session `a`
  approvals.
- `/tools` — already annotates mutating with ` *`; may also show each tool's
  effective policy (optional).

### 13.6 Tests
- `tests/permissions/policy.test.ts`: pure `evaluate` across mode × rule ×
  read-only/mutating × in-session `a` × `*` wildcard.
- `tests/permissions/harness.test.ts`: `ask`→`y`/`n`/`a` mapping; `a` persists
  per-tool; one-shot `ask`→deny; `*` wildcard; `deny` hides tool from schema.
- `tests/cli/repl.test.ts`: `/mode` get/set; `/reset` clears approvals.

### 13.7 Files touched
`permissions/policy.ts` (new), `permissions/harness.ts` (new), `ui/prompt.ts`
(new), `src/tools/registry.ts` (or `src/agent/loop.ts`), `src/cli/repl.ts`,
`src/cli/commands.ts`, `src/agent/loop.ts`, `src/index.ts`, `README.md`,
`CHANGELOG.md`. Version → `0.4.0` on completion.

### 13.8 Out of scope
Argument/command specifiers (`run_shell(rm *)`), durable/project-scoped
approvals, hooks, sandboxing, managed/enterprise policy layers. Revisit in P7 if
needed.

### 13.9 Status
**Cancelled** — the permission architecture was removed on the `experiment`
branch (see §5); this design is no longer pursued.

## 14. P8 Specification (in-session task list) — implemented

Status: **Done**. Gives the model a lightweight, model-driveable task list so it
can plan and track work during a run. Sub-agents / task-management orchestration
were researched (opencode, Claude Code, Pi) and **deferred** — this phase ships
only the task list, in-session, with no persistence, no config, and no new CLI
surface.

### 14.1 Scope
- A single `todo` tool (action: add / list / update / done), driven by the model
  via normal tool calls. Replaces the earlier `task_create` / `task_list` /
  `task_update` trio. No extra UI beyond the `/todo` REPL command (alias `/tasks`).
- A `TaskStore` (in `agent/tasks.ts`) holding tasks in memory for the session.
- Out of scope: on-disk persistence, dependencies graph/enforcement, sub-agents
  / `delegate` tool, background execution, worktree isolation, parallel fan-out.
  These are recorded as deferred P8b+ decisions (see §14.5).

### 14.2 Data model
```ts
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'
export interface Task {
  id: string            // "T1", "T2" — sequential per session
  title: string
  status: TaskStatus
  blockedBy: string[]   // task ids, for visibility only (no enforcement)
  notes?: string
}
```
Sequential `T{n}` ids keep references easy for the model. `blockedBy` is recorded
for visibility in `todo` list; it is not enforced.

### 14.3 Module changes
- `src/agent/tasks.ts` (new): `TaskStore` with `create` / `get` / `list` /
  `update`. No file I/O.
- `src/tools/local/todo.ts` (new): `todoTool(store)` — one `ToolDefinition` with an
  `action` discriminator that **closes over** the session's `TaskStore`.
- `src/tools/index.ts`: `createLocalTools(tasks: TaskStore)` registers the single
  `todo` tool alongside the locals + web tool.
- `src/cli/repl.ts` and `src/index.ts`: create one `TaskStore` per session and
  pass it into `createLocalTools`. `src/cli/commands.ts` exposes it as `/todo`
  (alias `/tasks`).

### 14.4 Tests
- `tests/agent/tasks.test.ts`: sequential ids, `list` order, `blockedBy` capture,
  `update` transitions, missing-id safety.
- `tests/tools/task.test.ts`: each `todo` action (add/list/update/done), id/title
  requirement errors, unknown-id error, and schema rejection of an invalid
  `status`.

### 14.5 Deferred (decided during planning)
Sub-agents were explicitly deferred. When they land, the following conventions
were locked in so a future P8b is consistent: agent definitions as
Markdown+frontmatter files (`.dcode/agents/` project + `~/.config/dcode/agents/`
global), subagents inherit the parent model (no per-agent override in v1), and
task state stays in-session.

## 15. P9 Specification (scoped git tool) — implemented

Status: **Done**. Adds a dedicated `git` tool so the model can run common, safe
git operations without shell-escaping concerns or reaching for `run_shell`. Git
was previously only available via `run_shell` (P4 design, §12.6).

### 15.1 Scope
- A `git` tool exposing a curated allowlist: `status`, `diff`, `log`, `show`,
  `add`, `commit`, `branch`.
- `execFile('git', …)` (no shell) so paths/refs can't be shell-injected; runs
  with `cwd = root` and `-C <root>`, plus the same `timeout` / `signal` kill-on-
  abort handling as `run_shell` (decision L), and `runTool`'s truncation
  (decision F) / error-as-output (decision D).
- Out of scope: remote/destructive commands (push, pull, fetch, reset, checkout,
  clean, merge, rebase, rm, restore) — those stay in `run_shell`. Path and ref
  inputs are confined (resolvePath rejects `../` and symlink escapes; refs may
  not start with `-` or contain whitespace).

### 15.2 Module changes
- `src/tools/local/git.ts` (new): `gitTool()` — `parameters` is a zod object with
  a `command` enum plus optional `paths` / `message` / `staged` / `oneline` /
  `maxCount` / `ref`. `buildArgs` maps the validated request to git argv;
  `checkPaths` confines each path via `resolvePath`, `checkRef` rejects unsafe
  refs.
- `src/tools/index.ts`: `createLocalTools` registers `gitTool()` (and the rest of
  the local set) in the `ToolRegistry` alongside `webTools` and `todoTool`.

### 15.3 Tests (`tests/tools/git.test.ts`)
A real temp git repo (init + seed commit) asserts: clean `status`, `add` +
`commit` recorded in `log`, `diff` shows edits, `show HEAD` prints the commit,
`branch` lists; schema rejection of an out-of-allowlist command; path-escape
rejection; and a clear error when run outside a git repository.

### 15.4 Status
**Done.** `git` joins the local tool set, confined to the working directory with
a safe operation allowlist and no shell. Covered by `tests/tools/git.test.ts`.

## 16. P10 Specification (context-window management) — implemented

Status: **Done**. Keeps each request within the model's context window without a
tokenizer dependency, by (a) pruning old tool outputs cheaply and (b) summarizing
the oldest history with a model call when pruning isn't enough. Inspired by
opencode's prune→compact cascade and Claude Code's structured summary contract.

### 16.1 Scope
- `ContextManager` (session-scoped) owns all context management; the loop calls
  `beforeTurn` before each request and `observe` after each response.
- Token budget from real provider `usage` (calibrated heuristic, no new dep).
- Cheap prune (`pruneHistory`) collapses old `function_call_output` payloads.
- Model-call compaction (`compactHistory`) summarizes the oldest history into a
  single `user` message, retaining a recent tail verbatim.
- Overflow recovery: on a context-window error, compact and retry the request
  once; a circuit breaker stops thrashing after 3 consecutive failures.
- REPL commands `/compact` (manual) and `/context` (usage report).

### 16.2 Design
- **Estimate.** `tokens.ts`: `estimateTokens ≈ chars/4` over each item's text.
  `ContextManager.observe(usage, history)` sets `ratio = real_input_tokens /
  heuristic(history)` from the provider's `usage.input_tokens`, so `predict`
  tracks the model's real tokenizer. When `usage` is absent (tests/offline),
  `ratio` stays 1.
- **Prune.** `pruneHistory` replaces all but the most recent `protectTurns`
  (default 2) tool outputs with `[output truncated] (N chars)`. Cheap, lossy,
  no model call.
- **Compact.** `compactHistory` keeps the most recent `keepTokens` (default
  15000) tokens as a verbatim tail, **snapping the cut to a `user` message** so a
  `function_call` is never separated from its `function_call_output` (orphaned
  tool calls are rejected by the API). The rest is fed to a separate model call
  (tools disabled, `maxOutputTokens: 4096`) with a structured-summary prompt
  (Goal / Constraints / Progress / Key Decisions / Next Steps / Critical
  Context). The summary replaces the old items as a `user` message; the
  model call's own tokens are discarded. `user` (not `developer`/`system`) is
  used for the summarization input and the injected summary because several
  OpenAI-compatible / local endpoints reject those roles as input messages and
  return a non-conformant `output` shape the SDK can't parse.
- **Manager.** `beforeTurn`: if `predict >= usable` (`window - reserved`), prune,
  then compact if still over. `usable()` and the breaker make it safe. A healthy
  turn that fits resets the failure counter.
- **Overflow.** `client.stream` gains `maxOutputTokens?`; `isContextOverflowError`
  detects OpenAI's 413 / `context_length_exceeded`. `loop.ts` catches it,
  calls `onOverflow` (compact + retry once), and lets it fail normally if the
  breaker is tripped.

### 16.3 Config (`schema.ts`)
```ts
context: z.object({
  auto: z.boolean().default(true),
  window: z.number().int().positive().default(200000),  // model's real context limit
  reserved: z.number().int().nonnegative().default(20000), // headroom for output + compaction
  keepTokens: z.number().int().positive().default(15000),  // recent tail kept verbatim
  prune: z.boolean().default(true),
}).default({})
```
`window` must match the model in use (e.g. set lower for small local models); the
default assumes an OpenAI-scale window.

### 16.4 Tests
`tests/agent/context/{tokens,prune,compact,manager}.test.ts`: heuristic + history
estimation; prune protects the newest outputs; compact summarizes oldest and
keeps the tail; manager compacts when over budget, trips the breaker after
repeated failures, and `onOverflow` recovers-then-gives-up; `isContextOverflowError`
detects the right errors.

### 16.5 Status
**Done.** REPL and one-shot both run a `ContextManager`; history stays within the
configured window, and a context-window overflow is recovered transparently.
Covered by `tests/agent/context/*`. The in-session task list survives compaction
(it lives outside `history`), so `/compact` never loses tracked work.

## 17. REPL command backlog

Candidate slash commands deferred from the v0.10.0 command pass:

- **`/save [path]`** — **Implemented** (see §26): writes the conversation
  transcript (`history`) to a file — Markdown (`.md`) or verbatim JSON — and
  refuses to overwrite an existing file.
- **`/limit <n>`** — **Implemented** (see §26): sets `maxToolIterations` at
  runtime (so runaway-loop caps can be tuned without restarting). `/keep <tokens>`
  for `context.keepTokens` remains deferred.

Lower priority, also considered: `/mode` (read-only vs. mutate toggle; see
cancelled P5), `/cost` (cumulative token-cost estimate building on `/context`),
`/branch` (snapshot `history` to fork and revert).

## 18. Tool roadmap (recommendations)

Beyond the current set (inspect: `read_file`/`list_dir`/`stat`/`grep`/`glob`;
mutate: `write_file`/`edit_file`/`run_shell`/`git_*`; web: `web_fetch`/
`web_search`; `todo`), the following tools would raise dcode's usefulness.
Ranked by value/effort:

- **Tier 1 — file lifecycle (safety).** `move_file`/`rename`, `copy_file`,
  `delete_file` (with a guard against deleting the working-directory root),
  `make_dir`. These replace risky `run_shell` `mv`/`cp`/`rm` while keeping
  `resolvePath` confinement + structured errors.
- **Tier 2 — process control (biggest capability jump).** `run_process` (spawn a
  background command — a dev server, test watcher, or any long-running job —
  and return a handle), `read_process` (tail its output), `kill_process` (stop
  it). Today `run_shell` only runs foreground-to-completion.
- **Tier 3 — richer introspection.** `find_symbol` / `find_references`
  (LSP-lite via tree-sitter or ripgrep); `read_image` (multimodal) for UI work;
  `watch` (fs-event notifications) for tight TDD loops.
- **Tier 4 — optional/niche.** `apply_patch` (atomic multi-file edits from a
  unified diff); `http_request` (call the user's own API for testing;
  security-scrutinized); `memory` (persist facts across sessions).

P11 (this round) ships Tier 1 + `run_process`/`read_process`/`kill_process`.

## 19. P11 Specification (file lifecycle + background process tools) — implemented

Status: **Done**. Adds safe file-lifecycle operations (so refactors and
cleanups don't need raw `run_shell` `rm`/`mv`/`cp`) and background-process
control (for dev servers, watchers, and any long-running command).

### 19.1 Scope
- File ops: `move_file`, `copy_file`, `delete_file`, `make_dir`, all
  `resolvePath`-confined to the working directory.
- Background control: `run_process` (spawn, return a handle + pid),
  `read_process` (tail output + exit status), `kill_process` (stop the process
  group with a chosen signal).
- `delete_file` refuses to delete the working-directory root itself; directory
  deletion requires `recursive: true`.

### 19.2 Module changes
- `src/tools/local/fs.ts`: add `move_file` (rename, creating the destination
  parent dir), `copy_file` (copyFile), `delete_file` (rm, root-self-delete
  guard), `make_dir` (mkdir -p). All errors routed through `fsError`.
- `src/tools/local/process.ts` (new): `ProcessManager` (module singleton)
  spawns via `child_process.spawn` with `detached: true`, scrubs secrets via
  `safeEnv`, confines `cwd` to the root, caps buffered output
  (`PROC_MAX_OUTPUT`), and kills the process *group* (`process.kill(-pid)`) on
  `kill_process` and on the session `ctx.signal` abort. `run_process`,
  `read_process`, `kill_process` tools. `killAll()` runs on process exit.
- `src/tools/index.ts`: register the four fs tools and the three process tools.

### 19.3 Tests (`tests/tools/local.test.ts`)
- File ops: make_dir (nested); move_file (file + dir, creates dest parent);
  copy_file (content + dest parent); delete_file (file; recursive dir; root
  self-delete refused); path-escape rejection.
- Process: run_process starts and returns a handle; read_process tails output
  and reports running/exited; kill_process stops a long-running command (assert
  it exits); unknown-handle errors; leaked processes killed in `afterEach`.

### 19.4 Status
**Done.** File-lifecycle and background-process tools join the local set,
confined to the working directory. Covered by `tests/tools/local.test.ts`.

## 20. P12 Specification (symbol search — find_symbol / find_references) — planned

Adds LSP-lite symbol search over the working directory. v1 uses
ripgrep-style heuristics (zero new dependencies, reuses the existing search
traversal) rather than tree-sitter/LSP; a precise tree-sitter upgrade is a
later option.

### 20.1 Scope
- `find_symbol(name, kind?, path?)` — locate definition sites using a small
  per-language definition-regex map (e.g. `function\s+<name>`, `class\s+<name>`,
  `def\s+<name>`, `const\s+<name>\s*=`, `type\s+<name>\s*=`), keyed by file
  extension. Reuses `walkDir` + `GREP_MAX_MATCHES`.
- `find_references(name, kind?, path?)` — word-boundary (`\b<name>\b`) search
  across files of the same language family. Best-effort: cannot resolve
  scoping, so it may include shadowed/同名 symbols (stated in the tool
  description).

### 20.2 Module changes
- `src/tools/local/search.ts`: add `findSymbolTool()`, `findReferencesTool()`;
  add a `langDefRegex` map (TS/JS/Python/C/Rust first). Both `resolvePath`-
  confined, capped + footer like `grep`.

### 20.3 Tests (`tests/tools/search.test.ts`)
- Definition matching for each supported language; `kind` filter narrows
  results; `find_references` finds usages and ignores non-word-boundary
  substrings; path confinement (escape rejection); cap + footer.

### 20.4 Status
**Planned.** Tree-sitter/LSP precision (curated grammars, scoped references)
is a documented future upgrade, not part of v1.

## 21. P13 Specification (apply_patch — atomic multi-file unified-diff apply) — planned

Applies a unified diff (possibly multi-file) atomically: either every file
changes or none do. No new dependency — a minimal hand-rolled unified-diff
parser + temp-file-then-rename apply (the `diff` npm package is a fallback
only if parsing proves fiddly).

### 21.1 Scope
- `apply_patch(patch, dry_run?, allow_conflict?)` — parse a unified diff into
  per-file records, `resolvePath` each path (reject escapes), apply hunks to
  temp files, then `rename` each temp over its target only after *all* apply
  cleanly. On any failure (parse error, missing context lines, conflict) the
  whole patch is aborted and originals are untouched.

### 21.2 Module changes
- `src/tools/local/patch.ts` (new): `parseUnifiedDiff()`, `applyPatch()`
  (atomic + rollback), `applyPatchTool()`. Conflict detection (hunk context
  lines must still match the current file) is strict by default; `dry_run`
  reports the files that would change without writing.

### 21.3 Tests (`tests/tools/patch.test.ts`)
- Atomic success (multi-file); partial-failure rollback (originals
  unchanged); path-escape rejection; conflict detection; dry_run.

### 21.4 Status
**Planned.** Shell `patch` is deliberately not used (it escapes `root`
confinement and yields harder-to-structure errors).

## 22. REPL UX enhancements (cheap + safe) — implemented

Status: **Done.** Display-only improvements that don't change tool contracts
or the agent data flow.

- **Richer tool-status lines** (`src/agent/loop.ts` `renderToolResult`): the
  tool name is colored, the status check/cross stays green/red, and the
  duration is dimmed. Stripped text is unchanged, so the contract holds.
- **Colored diff preview** (`renderToolOutput`): unified-diff lines are colored
  (hunk headers cyan, `+` green, `-` red). Lights up `git diff` output in
  verbose mode. `edit_file` output stays `edited <path>` (no diff in the tool
  result, so the model contract is unchanged); the coloring is purely display.
- **REPL tab-completion** (`src/cli/completer.ts`, new; wired into
  `startRepl`): slash commands complete from the known list; otherwise the last
  whitespace-delimited token is completed as a path under the working
  directory, confined via `resolvePath` so it can't suggest escapes.

### 22.1 Tests
- `tests/cli/completer.test.ts`: slash-command completion; file/nested/dir
  completion; escape returns nothing.
- `tests/agent/loop.test.ts`: diff-line coloring preserves content under
  `ansis.strip`.

## 23. Global API-key storage — implemented

Status: **Done.** Lets a globally installed `dcode` persist secrets across
directories without editing JSON or exporting env vars per shell.

- `src/cli/keys.ts` (new): `setGlobalKey`/`unsetGlobalKey` write a single secret
  into `~/.config/dcode/dcode.json` (relocatable via `DCODE_CONFIG_HOME`), with
  the file at `0600` and its directory at `0700`. A small provider allowlist
  (`openai` → `apiKey`, `brave` → `brave`) stops `/key` from writing arbitrary
  config keys.
- `/key` REPL command (`src/cli/commands.ts`): `set <openai|brave> <value>`,
  `unset <openai|brave>`, `list` (shows set/unset, never the values). Setting a
  key also updates the live session config so it takes effect immediately.
- `schema.ts` adds a `brave` field; `config.ts` folds `BRAVE_API_KEY` into config
  (env > file > default, same precedence as `apiKey`). `web_search` reads
  `ctx.config.brave ?? process.env.BRAVE_API_KEY`.
- `/config` now prints a `keys: openai=set brave=unset (values hidden)` line.
- Key resolution precedence: CLI > env > global config > schema default. Secrets
  are never logged and are not echoed by `/key list`.

### 23.1 Tests
- `tests/cli/keys.test.ts`: 0600 perms, field merge, unset, provider allowlist.
- `tests/config/config.test.ts`: `buildConfig` picks up `apiKey`/`brave` from the
  global config when env is unset.
- `tests/tools/web.test.ts`: `web_search` uses `ctx.config.brave` when env unset.

## 24. Dropped `.env` auto-loading — implemented

Status: **Done.** `dcode` no longer auto-loads a `.env` file. Config resolution is
now exclusively `CLI > env (process) > global ~/.config/dcode/dcode.json > schema
defaults` (with an explicit `--config <path>` replacing the global file).

Rationale: the global `~/.config/dcode/dcode.json` (set via `/key`) covers
secret/config needs; the `.env` loader lived in the `src/index.ts`
shebang and was cwd-relative (so a global install got no global `.env`) and did
not apply to Windows bin installs. `process.env` is still read (shell-exported
vars) — distinct from `.env` file loading.

Changes: removed `--env-file-if-exists=.env` from the `src/index.ts` shebang and
the `dev`/`start`/`stress` scripts; updated the missing-key / invalid-key
guidance in `src/index.ts` and the config docs in `README.md`/`AGENTS.md`.

## 25. Dropped repo-local `./dcode.json` discovery — implemented

Status: **Done.** dcode targets a globally installed, general-purpose use rather
than repo-based use, so automatic discovery of a local `./dcode.json` / `.dcode.json`
in the working directory was removed. Config resolution is now
`CLI > env (process) > global ~/.config/dcode/dcode.json > schema defaults`, with
an explicit `--config <path>` replacing the global file. `loadConfig` no longer
searches the cwd for config files; the loadConfig/mergeConfigs tests were updated
(explicit `--config` file is used instead of global; the precedence integration
test asserts global < env < cli). Guidance text in `src/index.ts` points to
`/key` / the global file.

## 26. REPL ergonomics + parallel reads — implemented

Status: **Done.** A batch of small, high-value improvements shipped together:

### 26.1 Parallel read-only tool execution
`ToolDefinition` gains an optional `parallel?: boolean` (default `true`). The
agent loop batches consecutive read-only calls via `Promise.all` while running
mutating calls (`parallel: false`) sequentially in emission order. This restores
the parallel-reads behavior that was lost when the P5 gate/parallel split was
removed (§12.12) — but as pure scheduling, with no permission prompt. All
mutating tools (`write_file`, `edit_file`, `move_file`, `copy_file`,
`delete_file`, `make_dir`, `run_shell`, `git`, `run_process`, `kill_process`)
set `parallel: false`; read-only tools keep the default.

### 26.2 `/save` and `/limit` REPL commands
- `/save [path]` writes the conversation `history` to a file. A `.md` extension
  renders a Markdown transcript; otherwise it writes verbatim JSON
  (`ResponseInput`) for reload. Defaults to `dcode-transcript.json` under `root`
  and refuses to overwrite an existing file (no confirmation prompt exists).
- `/limit <n>` sets `maxToolIterations` at runtime.

### 26.3 Files touched
`src/agent/types.ts` (`parallel`), `src/agent/loop.ts` (`runCalls` batches
parallel calls), `src/tools/local/{fs,shell,git,process}.ts` (`parallel:
false`), `src/cli/commands.ts` (`/save`, `/limit`, `historyToMarkdown`),
`tests/agent/loop.test.ts`, `tests/cli/repl.test.ts`, `tests/cli/commands.test.ts`.



