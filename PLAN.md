# PLAN.md — dcode

Product plan for **dcode**, a CLI-based AI coding agent built on the OpenAI
Responses SDK.

**Status:** P0–P11 and P6 are done; P5 (declarative permissions) was designed
then cancelled and fully removed — every tool call, including MCP tools,
runs unconditionally with no approval layer. P12–P22 are planned or
candidate work, not scheduled. See §8 for the full phase table.

**What this file is for.** §1–§9 are the living reference: vision, goals,
locked decisions, the CLI surface, and the phase table — keep these current.
§10 is the forward-looking roadmap for work not yet built. §11 is a compact
log of what each past phase did and why, for context on the shape of the
system — it intentionally does **not** duplicate the implementation detail
that [AGENTS.md](./AGENTS.md) and [ONBOARDING.md](./ONBOARDING.md) already
carry (and keep current against the actual code); when this file and those
disagree on present-tense architecture, they and the code win.

## 1. Vision

A small, modular, locally-run coding agent you drive from a terminal:

- One-shot: `dcode "add a CLI flag to parse --verbose"`
- REPL: `dcode` then chat, with slash commands.
- Uses local system tools (files, shell) and configured MCP servers.
- Fully async agent loop; read-only calls batch in parallel, everything else
  runs in emission order.
- Streaming model output, configurable models.

## 2. Goals

- Correctness and simplicity over feature breadth.
- Modular enough to add tools/transports without refactoring the loop.
- Every behavior covered by fast, deterministic unit tests.
- No build step: Node 26 runs `.ts` directly via type stripping.

## 3. Non-goals

- Declarative permissions, approval gating, or sandboxing — designed once
  (§11's P5 entry) and deliberately not pursued; every tool call, local or
  MCP, runs the moment the model asks for it. See AGENTS.md's Security model.
- Conversation persistence across runs (ephemeral: in-session only).
- Browser/UI; this is a terminal tool.
- Provider abstraction beyond OpenAI-compatible endpoints (configurable base URL).

## 4. Stack

- **Runtime:** Node.js 26+ (type stripping, no `tsc` build).
- **Language:** TypeScript 7+ (strict, ESM, `erasableSyntaxOnly`).
- **Package manager:** pnpm only.
- **Tests:** Vitest 4+.
- **Runtime deps:** `openai`, `zod`, `execa`, `@vscode/ripgrep`, `marked` +
  `marked-terminal`, `node-html-markdown`, `@clack/prompts`,
  `@modelcontextprotocol/sdk` (P6).
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
  index.ts            # entry: parse CLI -> build config -> ensureApiKey -> one-shot or REPL
  cli/args.ts         # FLAGS table -> parseArgs options + formatFlags() for --help; parseCli(argv) -> CliOptions (strict: an unknown flag is an error)
  cli/repl.ts         # readline loop; builds the Session (async — connects MCP servers) and drives runAgent
  cli/commands.ts     # Session type, parseCommand/dispatch for slash commands
  cli/auth.ts         # validateApiKey + ensureApiKey: the whole startup key path (prompt -> check -> persist)
  cli/keys.ts         # setGlobalKey/unsetGlobalKey: /key writes secrets to the global config, 0600/0700
  config/schema.ts    # zod schema (Config), .strict()
  config/config.ts    # buildConfig(args) [file+env+args] + readConfigFile(path) + normalizeBaseURL
  agent/client.ts     # wraps OpenAI Responses API (streaming); ModelStream
  agent/system.ts     # buildSystemPrompt(opts?: {subagents?}): core+Sub-agents+Style sections, `subagents: false` drops the Sub-agents section (used for the depth-limited `general` sub-agent); appends the cwd's AGENTS.md (else CLAUDE.md) as a capped Project instructions section
  agent/turn.ts       # runTurn (one model turn; streams + renders, returns the Response)
  agent/exec.ts       # runTool (one tool call, timeout+truncate) + runCalls (parallel/sequential scheduling)
  agent/loop.ts       # runAgent: tool-calling loop; runOneShot wraps it for one-shot
  agent/runtime.ts    # createRuntime: client + TaskStore + connected MCP servers + tool registry — the startup wiring one-shot, the REPL, and `pnpm stress` share
  agent/context/      # context-window management (P10):
                      #   tokens.ts  (cheap ~4c/tok estimate, calibrated by real usage)
                      #   prune.ts   (collapse old tool outputs to a marker)
                      #   compact.ts (summarize oldest history via a model call)
                      #   manager.ts (ContextManager: prune→compact, overflow retry, breaker)
  agent/types.ts      # shared types (ToolDefinition<P> incl. optional jsonSchema for MCP tools, ToolContext incl. depth, ToolCall, ToolResult, ResponseItemFields) + TaskStore: in-session todo list (replace/list — the model sends the whole list)
  agent/subagent.ts   # AGENT_TYPES (general, explore): per-type ToolPolicy ({allow} | {deny}) + system prompt; describeAgentTypes/unknownAgentTools
  tools/index.ts      # createLocalTools(tasks, client, mcpTools?): hub that registers all built-in tools (+ any already-connected MCP tools, P6) into the registry
  tools/registry.ts   # ToolRegistry: register/list/get (built once; toResponsesTools memoized); zod->JSON-schema via z.toJSONSchema (or a tool's own jsonSchema verbatim); defineTool (infers a tool's arg type from its schema)
  tools/local/        # local tool set, split by concern:
    paths.ts          #   resolvePath, withFsError, ensureParentDir — path confinement (realpath-checked against symlink escapes) + shared fs error/mkdir idioms
    exec.ts           #   run_shell + baseExecOptions/safeEnv/childMaxBuffer — shared execa options (cwd/timeout/cancelSignal/maxBuffer scaled from maxToolOutputBytes, env redaction); safeEnv is also reused by tools/mcp/manager.ts
    http.ts           #   fetchSafely (timeout, native redirects), readBounded — shared network boundary for web.ts (no host filtering; opencode-style)
    fs.ts             #   read_file (also lists a directory), write_file, edit_file
    search.ts         #   grep, glob — both ripgrep-backed (@vscode/ripgrep's bundled binary, spawned directly, not via exec.ts); find_symbol/find_references planned, P12
    process.ts        #   run_process, read_process, kill_process — background, via execa (killDescendants: true)
    todo.ts           #   todowrite (single tool over TaskStore: the model sends the full list each call)
    question.ts       #   ask_user (@clack/prompts; refuses when stdin isn't a TTY)
    task.ts           #   task (sub-agent: filtered tool registry + own TaskStore, depth-limited to 1)
    web.ts            #   web_search (Brave; key from ctx.config.braveApiKey only), web_fetch
  tools/mcp/manager.ts  # connectMcpServers: connect enabled servers (local/remote), wrap their tools as ToolDefinitions, close() on exit/SIGINT (P6, §11)
  ui/markdown.ts         # renderMarkdown, MarkdownStreamRenderer (marked + marked-terminal) — see §5's "Markdown rendering" note
  ui/tools.ts            # tool-call rendering: interactive TTY = a per-query live counter that freezes into a bounded category summary (renderProgressLine/renderCategorySummary/TurnTally); piped/--verbose = per-call lines (renderToolResult/renderToolOutput)
  ui/sink.ts             # RunSink (write-only output seam) + CapturingSink for tests/stress
  types/marked-terminal.d.ts # local ambient types (marked-terminal ships none; @types/marked-terminal on npm is stale/mismatched)
  util/color.ts         # paintFor(color) — the one place styleText is applied, shared by util/log.ts and ui/tools.ts
  util/log.ts           # diagnostics -> stderr (never console.log); errorMessage, isAbortError
```

### Markdown rendering

Model output is markdown; `runTurn` (`agent/turn.ts`) pipes streamed deltas
through `ui/markdown.ts`'s `MarkdownStreamRenderer` before writing to the
sink, instead of writing raw deltas. The renderer buffers text and only
renders+emits a block once its boundary is unambiguous — a blank line for
prose/headings/lists, a closing ` ``` ` for code fences — so a client never
sees a partial `**` or a code block rendered before it closes. This is a
scaled-down version of the "newline-gated" pattern both Codex CLI's Rust TUI
and independent streaming-markdown libraries converge on; unlike Codex,
dcode doesn't hold back tables or handle retroactive reference-link
resolution. Rendering itself is `marked` + `marked-terminal` (same library
OpenAI's own Codex CLI TypeScript implementation uses). `--no-color` *is*
honoured, but only after the fact: `marked-terminal` styles through its own
`chalk` import, whose colour level is fixed at module load — before argv is
parsed — and its options only let you replace individual node renderers, not
force plain output. So `renderMarkdown`/`MarkdownStreamRenderer` take an
explicit `color` flag and strip the codes with `stripVTControlCharacters()`
when it is false. Everything dcode renders itself instead consults
`config.color` up front, via `util/color.ts`'s `paintFor`.

### Agent loop

1. Send conversation `input` + tool defs to the Responses API (streaming).
2. Render streamed text; collect `function_call` items.
3. When the turn ends, split calls into **parallel-eligible**
   (`Promise.all`) and **sequential** (`parallel: false`, run in emission
   order) groups, purely as a scheduling hint. Nothing is gated — P5 was
   cancelled; MCP tools included.
4. Feed `function_call_output` items back; repeat until no tool calls.
5. Cap loop iterations (`maxToolIterations`, default 16); feed tool errors back
   so the model can self-correct. Hitting the cap with tool calls still
   pending logs a warning naming the setting — otherwise the loop returns the
   last turn's text, which for a pure tool-call turn is nothing at all.

### Future: `reasoning: { summary: ... }` for streaming feedback

dcode never requests `reasoning.summary` on the Responses API call
(`client.ts`), so on a reasoning-heavy turn with a reasoning model (the
default `gpt-5.4-mini`, or a stronger o-series/GPT-5 model configured by the
user) the terminal can show zero streamed output for a while before final
text or a tool call appears — it can look like a hang. Requesting reasoning
summaries would stream `response.reasoning_summary_text.delta` events during
that gap, giving the user incremental feedback. Not yet implemented — noted
here as a candidate improvement, not scoped/designed.

### Permission model

**None, deliberately.** A harness gate and a full declarative modes/rules
design (§11's P5) were built, then removed — `runCalls` executes every tool
call unconditionally in the order the model emitted it, local and MCP alike.
There is no approval prompt and no `--mode`/`--auto`/`--plan` flag. See
AGENTS.md's Security model for the reasoning.

## 6. Locked decisions

| # | Topic | Decision |
|---|-------|----------|
| A | Config format | JSON (zero extra deps) |
| B | History | In-memory `ResponseInput` array bounded by token-budget compaction (`ContextManager`); `/reset` drops, `/clear` screen-only |
| C | Shell model | Real shell (`/bin/sh -c`), ungated, cwd-confined |
| D | Loop term | Cap (16, configurable) + feed tool errors back as `function_call_output` |
| E | `always` scope | Per-tool, session-scoped (cleared by `/reset`) — a P5 concept, now moot since nothing is gated |
| F | Result size | Truncate to `maxToolOutputBytes` (32 KB) + note |
| G | Workdir | Always `process.cwd()` (no configurable `root`) |
| H | Injection | Pass through raw, documented as untrusted |
| I | MCP life | Connect enabled servers at startup, session-lived, close on exit/SIGINT |
| J | Persistence | Ephemeral v1 (in-session up/down only) |
| K | bin | `bin: dcode -> src/index.ts`, shebang, engines >=26 |
| L | Cancel | Ctrl-C aborts stream + SIGTERMs shell child, returns to prompt |

Do not reopen these without explicit agreement (CLAUDE.md).

## 7. CLI surface

```
dcode [prompt]      one-shot when a prompt is given, REPL otherwise
  --model <id>       --config <path>    --verbose   --no-color   --version   --help
```

Slash commands (REPL): `/help` `/key` `/model` `/tools` `/mcp` `/clear`
`/reset` `/compact` `/context` `/tasks` (alias `/todo`) `/config` `/undo`
`/version` `/limit` `/edit` `/save` `/exit`. See README's REPL section for
what each does; §10 has deferred candidates.

## 8. Phase plan

| Phase | Scope | Status |
|-------|-------|--------|
| P0 | Scaffold & tooling (this document set) | **Done** |
| P1 | Config + OpenAI client + one-shot (no tools) | **Done** |
| P2 | REPL + slash commands + streaming in REPL | **Done** |
| P3 | Tool core + read-only tools + async loop (parallel read-only) | **Done** |
| P4 | Mutating local tools (write_file/edit_file/run_shell) | **Done** |
| P5 | Declarative permissions + modes | **Cancelled**, fully removed |
| P6 | MCP integration | **Done** |
| P7 | Polish (verbose/stderr, --no-color, SIGINT, docs pass) | **Done** |
| P8 | Task list (in-session: create/list/update) | **Done** |
| P9 | Git tool (scoped status/diff/log/show/add/commit/branch) | **Done, then removed** — no safety benefit over ungated `run_shell`; git is reached via `run_shell` |
| P10 | Context-window management (prune + compact + overflow retry) | **Done** |
| P11 | File lifecycle (move/copy/delete/mkdir) + background process tools | **Done** |
| P12 | Symbol search (`find_symbol` / `find_references`, ripgrep-lite) | **Planned** (see §10) |
| P13 | `apply_patch` (atomic multi-file unified-diff apply); `multi_edit` down-payment | **Planned** (see §10) |
| P14 | File inputs (let the model read local PDFs/images) | **Candidate** (see §10) |
| P15 | Cost tracking (`/cost`) | **Candidate** (see §10) |
| P16 | Model fallback on a retryable error | **Candidate** (see §10) |
| P17 | Tool definition enrichment (metadata fields) | **Candidate** (see §10) |
| P18 | History persistence + `/resume` | **Candidate** (see §10) |
| P19 | Streaming tool execution | **Candidate** (see §10) |
| P20 | Skills system (model-invocable prompt templates) | **Candidate** (see §10) |
| P21 | Hooks system (pre/post tool-use) | **Candidate** (see §10) |
| P22 | Plugin system | **Candidate** (see §10) |
| A3 | Max output tokens recovery ("Continue." injection) | **Done** |
| A7 | Multi-retry compaction (overflow retry loop) | **Done** |

P15–P22 were sourced from a comparison against Claude Code's architecture
(`tanbiralam/claude-code`); P15–P17 are independent and low-risk, P20–P22
have a dependency chain (P20/P21 build on P17's metadata, P22 needs both),
and P19 is the riskiest (a real streaming-pipeline refactor with an open
ordering question — see its §10 entry) so do it after the others, not first.

§11 has one compact entry per phase — what shipped and the one or two
decisions worth remembering. Landed outside the numbered phases (no new
locked decisions): streamed markdown rendering, the compact per-query tool
summary, `ask_user`, sub-agents (`task`), global API-key storage (`/key`),
REPL tab-completion, `/save`/`/limit`, and dropping `.env`/repo-local config
discovery in favor of the global config file only — see §11.

## 9. Testing strategy

- Tests live in `tests/`, mirroring `src/` (`tests/cli/args.test.ts` -> `src/cli/args.ts`).
- Prefer fast, deterministic unit tests over network integration.
- Mock external boundaries (OpenAI client, MCP SDK client/transports, `child_process`, `fs` side effects).
- For colored output, assert against `node:util`'s `stripVTControlCharacters(...)`.
- `tsc --noEmit` and `pnpm format:check` gate every commit.

## 10. Roadmap (planned / candidate work)

Work that hasn't been built yet. Once a phase here ships, its detailed spec
moves out of this section and into a short §11 entry — this section should
only ever describe the *not-yet-true* state of the system.

### P12 — Symbol search (`find_symbol` / `find_references`)

Adds LSP-lite symbol search over the working directory. v1 uses ripgrep-style
heuristics rather than tree-sitter/LSP; a precise tree-sitter upgrade is a
later option. `grep`/`glob` are already ripgrep-backed, so this reuses that
plumbing directly instead of reimplementing a regex-over-files scan.

- **Scope.** `find_symbol(name, kind?, path?)` locates definition sites via a
  small per-language definition-regex map (`function\s+<name>`,
  `class\s+<name>`, `def\s+<name>`, `const\s+<name>\s*=`, `type\s+<name>\s*=`,
  …), keyed by file extension, reusing `search.ts`'s `runRg` helper +
  `GREP_MAX_MATCHES`. `find_references(name, kind?, path?)` is a
  word-boundary (`\b<name>\b`) search across files of the same language
  family — best-effort, since it can't resolve scoping and may include
  shadowed/same-name symbols (state this in the tool description).
- **Module changes.** `src/tools/local/search.ts`: add `findSymbolTool()`,
  `findReferencesTool()`, a `langDefRegex` map (TS/JS/Python/C/Rust first).
  Both `resolvePath`-confined, capped + footer like `grep`.
- **Tests (`tests/tools/search.test.ts`).** Definition matching per
  supported language; `kind` filter narrows results; `find_references` finds
  usages and ignores non-word-boundary substrings; path confinement; cap +
  footer.
- Tree-sitter/LSP precision (curated grammars, scoped references) is a
  documented future upgrade, not part of v1.

### P13 — `apply_patch` (atomic multi-file unified-diff apply)

Applies a unified diff (possibly multi-file) atomically: either every file
changes or none do. No new dependency — a minimal hand-rolled unified-diff
parser + temp-file-then-rename apply (the `diff` npm package is a fallback
only if parsing proves fiddly).

- **Scope.** `apply_patch(patch, dry_run?, allow_conflict?)` parses a
  unified diff into per-file records, `resolvePath`s each path (reject
  escapes), applies hunks to temp files, then `rename`s each temp over its
  target only after *all* apply cleanly. Any failure (parse error, missing
  context lines, conflict) aborts the whole patch with originals untouched.
- **Module changes.** `src/tools/local/patch.ts` (new): `parseUnifiedDiff()`,
  `applyPatch()` (atomic + rollback), `applyPatchTool()`. Conflict detection
  (hunk context lines must still match the current file) is strict by
  default; `dry_run` reports the files that would change without writing.
- **Tests (`tests/tools/patch.test.ts`).** Atomic success (multi-file);
  partial-failure rollback (originals unchanged); path-escape rejection;
  conflict detection; dry_run.
- Shell `patch` is deliberately not used — it escapes `resolvePath`
  confinement and yields harder-to-structure errors.

**`multi_edit` — a down-payment on P13, sketched but not implemented.** A
smaller stepping stone that delivers most of P13's per-file value before the
full unified-diff machinery: apply **multiple string replacements to a
single file** in one call, **sequentially and atomically**.

- **Schema.** `multi_edit(path, edits: [{ old_string, new_string,
  replace_all? }])` (`edits` non-empty), `parallel: false`.
- Each edit runs against the *result* of the previous one (a running
  buffer), not the original — order-dependent, and the tool description
  must say so explicitly (this is what models most often get wrong about
  batch edits).
- Atomic, all-or-nothing: read once, apply every edit in memory, `writeFile`
  once at the end — any failure writes nothing, unlike calling `edit_file` N
  times and having the second one fail mid-way.
- Per-edit uniqueness inherited from `edit_file`: exact match, unique unless
  `replace_all`; literal `split`/`join` substitution (never
  `replace`/`replaceAll`, to avoid `$&`-style corruption).
- Indexed errors name the edit (`edit 2/3: old_string not found in <path>`)
  so the model knows which hunk to fix — without the index the atomicity
  guarantee is wasted.
- Share the core with `edit_file` via one `applyReplacement(text,
  old_string, new_string, replace_all, label)` helper, so the two tools
  can't drift; `edit_file` becomes one call into it, `multi_edit` a `reduce`
  over `edits`.
- Open questions to settle before implementing: no new-file creation via an
  empty first `old_string` (proposed: `write_file` keeps owning creation);
  no overlap pre-validation (proposed: sequential semantics + indexed errors
  already make outcomes predictable).

### P14 — File inputs (read local PDFs/images)

Lets the model actually read non-text artifacts. Today dcode is blind to
them: `read_file` refuses binary (NUL byte → "binary … not shown") and
`web_fetch` only describes it. The Responses API accepts a file three ways —
a `file_id` from `client.files.create`, an inline base64 `file_data` data-URI,
or a URL — as an `input_file`/`input_image` content part; on vision models a
PDF is decomposed into text + page images. This phase wires local PDFs and
images into that path so the agent can act on a spec, an RFC, a screenshot of
a failing UI, or a diagram.

- **Scope.** A `read_document(path)` tool (or a `read_file` branch) that,
  for a PDF or image under the working directory, emits an
  `input_file`/`input_image` content part instead of refusing, so the
  *next* model turn sees the artifact. Text files keep going through
  `read_file` unchanged. **v1 uses inline base64** (`file_data`/image
  data-URI), not `files.create`: one request, no server-side object to
  retain or clean up, and it keeps `store: false` intact — `files.create`
  is a later optimization for files past the inline size limit, not the
  entry point.
- **Two tensions to resolve first.** (1) `store: false`/privacy: inline
  base64 respects it, `files.create` does not (server-side retention) —
  if ever added, `files.create` must be opt-in and documented. (2)
  OpenAI-compatible-endpoint posture: file inputs are OpenAI-specific and a
  local/compatible endpoint may reject them (the same reason compaction
  avoids `developer`/`system` roles) — this must be capability-gated (a
  config flag or a real endpoint check) and degrade to today's "binary, not
  shown" when unavailable, never a hard failure.
- **Module changes.** `agent/client.ts`: `Client.stream`'s input path must
  carry structured content parts, not just text. `tools/local/fs.ts` (or a
  new `documents.ts`): PDF/image detection by extension + magic bytes, size
  cap, base64 encoding, `resolvePath`-confined as ever. `config/schema.ts`:
  a gate (e.g. `fileInputs: boolean`, default off).
- **Tests.** PDF/image produce the right content-part shape; a text file is
  unaffected; oversize is refused with a clear message; path-escape
  rejection; the gate off → today's "binary, not shown" behavior.
- **Status.** Candidate, not scheduled — additive capability, not a
  simplification; it earns its place only if reading PDFs/images is a real
  workflow need, and must clear the two tensions above first.

### P15 — Cost tracking (`/cost`)

Show cumulative token usage and estimated USD cost per session — the
deferred `/cost` candidate from §10's REPL-command list, filled in. Inspired
by Claude Code's `cost-tracker.ts`.

- **Scope.** `agent/cost.ts` (new): a `CostTracker` — `record(model, usage)`
  (called after each `runTurn`, same lifetime as `ContextManager`), `total()`
  (input/output tokens + estimated cost), `byModel()`, `reset()`. A hardcoded,
  updateable per-model pricing table; an unrecognized model costs $0 rather
  than erroring.
- **REPL.** `/cost` prints a per-model breakdown plus a total:
  ```
  Model         Input      Output     Cost
  gpt-5.4-mini  12,340     4,560      $0.0122
  Total                   16,900      $0.0122
  ```
- **Tests.** Record + total across multiple models tracked separately;
  unknown model → $0; `reset()` clears everything.
- **Files.** New: `src/agent/cost.ts`, `tests/agent/cost.test.ts`. Modify:
  `src/agent/loop.ts` (record after each turn), `src/cli/repl.ts` (create the
  tracker per session), `src/cli/commands.ts` (`/cost` dispatch).

### P16 — Model fallback

If the primary model fails with a retryable error (429 rate limit, 500/502/503
server error, timeout), retry once with a configured fallback model before
giving up. Inspired by Claude Code's `FallbackTriggeredError`/retry path.

- **Scope.** New `fallbackModel?: string` config field. In `agent/loop.ts`'s
  turn-retry path (alongside the existing overflow/continue recovery in
  `completeTurn`): on a retryable error, build a fallback `Client` via
  `createClient({ ...config, model: config.fallbackModel })` and retry once.
  **Not** retryable: 400 (bad request), 401/403 (auth), or a context overflow
  (already handled by its own recovery path, §11's A7).
- **Tests.** 429 on primary → fallback succeeds; 400 → no fallback attempted;
  no `fallbackModel` configured → original error propagates unchanged;
  fallback itself fails → original error propagates.
- **Files.** Modify: `src/config/schema.ts` (`fallbackModel`),
  `src/agent/loop.ts` (fallback retry), `tests/agent/loop.test.ts`.

### P17 — Tool definition enrichment

Optional, purely informational metadata on `ToolDefinition` — not wired into
any scheduling or approval logic (there is none to wire into; P5 stays
cancelled) — that P20 (skills) and P21 (hooks) below build on. Inspired by
Claude Code's per-tool `isReadOnly`/`isDestructive`/`interruptBehavior`
predicates.

- **Scope.** Add to `agent/types.ts`'s `ToolDefinition`: `readOnly?: boolean`
  (display only — `parallel` already drives real scheduling),
  `destructive?: boolean` (marks data-loss-capable tools, for future display
  or a future confirmation feature), `interruptBehavior?: 'cancel' |
  'block'`, `aliases?: string[]` (backward-compatible name aliases),
  `maxResultBytes?: number` (per-tool override of `maxToolOutputBytes`).
- **Registry.** `tools/registry.ts`'s `get()` also resolves aliases;
  `toResponsesTools()` omits aliased names so a tool never appears twice to
  the model.
- **UI.** `/tools` can annotate `(read-only)`/`(destructive)`.
- **Tests.** Alias resolves via `get()`; aliased tools don't double-register
  in `toResponsesTools()`; metadata fields round-trip on a retrieved tool.
- **Files.** Modify: `src/agent/types.ts`, `src/tools/registry.ts`,
  `src/ui/tools.ts`, `tests/tools/registry.test.ts`.

### P18 — History persistence + `/resume`

Save conversation transcripts to disk and resume a previous session — the
biggest UX gap relative to Claude Code's session history. dcode already has
`/save` (manual, one-shot, session §11) for an explicit snapshot; this adds
automatic, indexed persistence and a way to load one back in.

- **Scope.** New `agent/persist.ts`: `saveSession(history, meta): string`
  writes JSON to `~/.local/share/dcode/history/{timestamp}-{random}.json`;
  `listSessions(): SessionMeta[]` reads the directory (timestamp, model,
  root, message count, estimated tokens); `loadSession(path):
  ResponseInput`. New config: `history: { dir?: string, maxSessions:
  number.default(50) }`.
- **REPL.** On `/exit` (or process exit) with more than just the initial
  state, auto-save. New `/resume` command lists the last 10 sessions,
  numbered; picking one replaces `history` and updates `config.model` from
  the saved metadata. `dcode --resume <path>` for one-shot from a saved
  session.
- **Tests.** Save/load round-trips; `listSessions()` sorted by date; a
  corrupted file degrades to an empty history rather than crashing;
  `maxSessions` evicts the oldest.
- **Files.** New: `src/agent/persist.ts`, `tests/agent/persist.test.ts`.
  Modify: `src/config/schema.ts` (`history`), `src/cli/repl.ts` (auto-save,
  `/resume`), `src/cli/commands.ts` (`/resume` dispatch), `src/index.ts`
  (`--resume` flag).

### P19 — Streaming tool execution

Start executing a tool call as soon as it's fully received during streaming,
rather than waiting for the whole response to finish — can save real latency
per turn when tools are slow. Inspired by Claude Code's
`StreamingToolExecutor`. A moderate refactor of the streaming pipeline, and
the riskiest item on this list — do it after P15–P17, not first.

- **Scope.** `agent/client.ts`'s `ModelStream` gains a parallel
  `toolCalls(): AsyncIterable<ResponseFunctionToolCall>`, filtering
  `response.output_item.done` events where `item.type === 'function_call'`
  (distinct from the existing text-delta iterable). `agent/turn.ts`'s
  `runTurn` surfaces those early-collected calls alongside its normal
  `{text, response}` result. `agent/loop.ts` starts executing a call as soon
  as it arrives from `stream.toolCalls()`, instead of waiting for
  `finalResponse()`.
- **Open risk.** The SDK's event stream may not strictly guarantee that a
  `function_call` item is fully formed before later stream events arrive —
  confirm this before relying on it. If the model streams text *after* a
  tool call in the same turn (unusual but possible), early tool execution
  could race with text rendering; needs a concrete answer, not an assumption,
  before this ships.
- **Tests.** Tool execution measurably starts before the stream finishes;
  text rendering is unaffected; an aborted stream still yields whatever
  partial tool calls it already collected.
- **Files.** Modify: `src/agent/client.ts` (tool-call channel),
  `src/agent/turn.ts` (early tools), `src/agent/loop.ts` (start tools early).

### P20 — Skills system (model-invocable prompt templates)

Reusable prompt templates the model can invoke by name via a `skill` tool —
distinct from dcode's own harness-level `/help`-listed slash commands, this
is model-driven. Inspired by Claude Code's bundled/project/global skills
directories. Depends on P17 (a skill can restrict itself to a tool subset via
metadata).

- **Scope.** Skills are Markdown + frontmatter files under
  `~/.config/dcode/skills/` (global) and `.dcode/skills/` (project,
  optional): `name`, `description`, optional `tools: [...]`, then the prompt
  body. New `agent/skills.ts`: `loadSkills(dirs): Skill[]`. New `skill` tool
  (`tools/local/skill.ts`): `skill(name, input?)` returns the matched
  skill's prompt body plus the caller's `input`. `buildSystemPrompt` gains a
  short "Skills" section listing what's available, so the model knows to
  reach for the tool.
- **Tests.** Skills load from a directory; invoking one returns its prompt;
  an unknown name errors; a tool-restricted skill is noted in its listing.
- **Files.** New: `src/agent/skills.ts`, `src/tools/local/skill.ts`,
  `tests/agent/skills.test.ts`. Modify: `src/agent/system.ts` (inject the
  skills section), `src/tools/index.ts` (register the `skill` tool).

### P21 — Hooks system (pre/post tool-use)

Config-driven shell commands that run before or after a tool executes — e.g.
auto-format after `write_file`, lint after `edit_file`. Inspired by Claude
Code's `HookManager`. Depends on P17 for the tool-name matching this needs
(a bare `parallel` flag doesn't carry enough tool identity context to key
hooks off of cleanly, though in practice this can start from `tool.name`
directly and doesn't strictly block on P17 shipping first).

- **Scope.** New config: `hooks: { preTool: [{tool, command}], postTool:
  [{tool, command}] }` (`tool` is an exact name or a `*` wildcard). New
  `agent/hooks.ts`: `runHooks(hooks, toolName, ctx)` runs each matching
  `command` via `execa('sh', ['-c', command], {cwd: ctx.root, timeout:
  10_000})`. Wired into `agent/exec.ts`'s `runTool`: pre-hooks before
  `tool.execute()`, post-hooks after. **Non-blocking by default** — a hook
  failure is logged, not surfaced as the tool's own failure (a pre-hook that
  can actually deny execution is a deliberately separate, harder decision:
  it re-opens exactly the gate/approval question P5 settled by removing, so
  don't add hook-based blocking without revisiting that call explicitly).
- **Tests.** Pre-hook runs before execution; post-hook runs after; `*`
  matches every tool; a failing hook is logged but doesn't block the tool
  call.
- **Files.** New: `src/agent/hooks.ts`, `tests/agent/hooks.test.ts`. Modify:
  `src/config/schema.ts` (`hooks`), `src/agent/exec.ts` (hook execution
  around `runTool`).

### P22 — Plugin system

Load custom tools/skills/hooks from a local directory or npm package.
Inspired by Claude Code's plugin loader. The largest, riskiest item here —
depends on P20 + P21 both existing first, and is the last thing to attempt
in this group.

- **Scope.** A plugin is a directory or package exporting `tools`
  (`ToolDefinition[]`), `skills` (`Skill[]`), and `hooks` (merged into the
  hooks config). New `agent/plugins.ts`: `loadPlugins(dirs): Plugin[]`,
  dynamically `import()`ing each one; tools register into the
  `ToolRegistry`, skills load into the skills system, hooks merge in. New
  config: `plugins: string[]` (paths or package names). Discovery dirs:
  `~/.config/dcode/plugins/` (global), `.dcode/plugins/` (project, optional).
- **Tests.** Load a plugin from a directory; its tools register; its skills
  are available; an invalid plugin is logged and skipped, not fatal.
- **Files.** New: `src/agent/plugins.ts`, `tests/agent/plugins.test.ts`.
  Modify: `src/config/schema.ts` (`plugins`), `src/tools/index.ts` (register
  plugin tools), `src/agent/skills.ts` (load plugin skills).

### Considered and rejected

Surveyed from a comparison against Claude Code's own architecture; not worth
adopting into dcode:

- **A React/Ink-style TUI.** Real complexity for a terminal tool; readline +
  streamed markdown already covers the need.
- **Voice input, vim-mode line editing, notebook (`.ipynb`) editing.** Niche
  relative to dcode's scope; large surface for the value.
- **Session memory / automatic fact extraction across sessions.** Interesting,
  but premature before basic history persistence (P18) is solid — and in
  tension with decision J (ephemeral by default) until that's revisited on
  its own terms.

(A sandboxed permission system, a browser, and multi-agent coordination were
already excluded — see §3's non-goals and §11's cancelled-P5 entry.)

### Deferred REPL commands

`/branch` (snapshot `history` to fork and revert). `/cost` is now scoped as
P15 above rather than a loose candidate. `/continue` — resume a turn that
stopped at `maxToolIterations` without the throwaway follow-up prompt
`AgentResult.truncated` currently requires (see `runAgent`'s doc comment in
`agent/loop.ts`); `handleLine` would call `runAgent` again on `session.history`
directly, skipping the `{role: 'user', ...}` push it normally does first —
the mechanism (raise the limit, call `runAgent` again on the same history) is
already there and works today via any follow-up prompt, this just removes the
need for filler text.

## 11. Phase history

One entry per completed or cancelled phase: what it did, the decision worth
remembering, and where to look for the real detail (code comments,
ONBOARDING.md, AGENTS.md, git history) rather than re-explaining it here.

**P1 — Config + client + one-shot.** JSON config (decision A) via zod
(`config/schema.ts`), the OpenAI Responses client wrapper (`agent/client.ts`),
and `runOneShot`. Foundation for everything after it.

**P2 — REPL.** `cli/repl.ts`'s `startRepl` + `handleLine`, streaming turns via
`runTurn`, and the first slash commands (`/help`, `/model`, `/clear`,
`/reset`, `/version`, `/exit`). History is a plain `ResponseInput` array
(decision B); Ctrl-C aborts the in-flight turn via `AbortController`
(decision L) without exiting the process.

**P3 — Tool core + read-only tools + async loop.** Introduced `ToolDefinition`,
`ToolRegistry`, and `agent/loop.ts`'s `runAgent` tool-calling loop, plus the
first read-only tools (`read_file`, `list_dir`, `grep`, `stat`, `glob`;
`list_dir` and `stat` were later folded into `read_file` / `run_shell`, see P11).
zod→JSON-Schema conversion ended up using zod v4's built-in `z.toJSONSchema`
rather than a hand-rolled converter. Tool errors are fed back as
`function_call_output` (decision D) so the model can self-correct rather than
crashing the loop.

**P4 — Mutating local tools.** Added `write_file`, `edit_file`, `run_shell`
(git reached via `run_shell`, no dedicated tool) plus a harness approval gate
(`y`/`n`/`a` prompt) and a read-only/mutating call split. The gate was later
removed entirely (see P5); the mutating *tools* and the parallel/sequential
split survived as pure scheduling (`ToolDefinition.parallel`, default `true`,
`false` on every side-effectful tool) — see ONBOARDING.md's tool framework
section for the current shape (`runCalls` in `agent/exec.ts`).

**P5 — Declarative permissions + modes — cancelled.** A full policy design
was built: four modes (`interactive`/`auto`/`plan`/`dontAsk`), per-tool
allow/deny/ask rules with a `*` wildcard, rules-beat-mode precedence, and
hiding denied tools from the model entirely. It was implemented, then removed
on this branch along with P4's gate — `agent/gate.ts` is gone, `ToolDefinition`
has no `mutates`/policy flag, and every tool call runs unconditionally. See
AGENTS.md's Security model for why (a partial in-process gate added little
real safety on top of an already-ungated `run_shell`, while costing
complexity and a worse-feeling UX). Not being revived; if the calculus ever
changes, the design lives in this file's git history.

**P6 — MCP integration.** `tools/mcp/manager.ts`'s `connectMcpServers`
connects every `mcpServers` entry with `enabled: true` (default `false` —
opt-in per server) in parallel at startup, over stdio (`type: "local"`) or
streamable HTTP (`type: "remote"`, static headers only, no OAuth), using the
official `@modelcontextprotocol/sdk` client. Each server's tools become
ordinary `ToolDefinition`s named `mcp__<server>__<tool>`, indistinguishable
to the loop, `task` sub-agent filtering, and `/tools`/`/mcp` from built-ins.
A `headers`/`env` value that is exactly `${VAR_NAME}` expands from
`process.env` at connect time, so a server's secret never has to sit in
`dcode.json`. A server that fails to connect, or is disabled, is recorded in
`McpManager.servers` with a distinct status rather than blocking startup.
Closed on exit/SIGINT (decision I). See ONBOARDING.md's MCP
integration section for the current implementation shape.

**P7 — Polish.** `--verbose`/stderr diagnostics, `--no-color`, SIGINT
handling, and a documentation pass. No new locked decisions.

**P8 — In-session task list.** A single `todowrite` tool (the model resends
the whole list each call, so its view and dcode's can't drift field-by-field)
backed by `agent/types.ts`'s `TaskStore`. Sub-agent orchestration was
explicitly deferred here and shipped later as part of the task tool (see
"landed outside phases" in §8) — when it landed, the sub-agent's own
`TaskStore` conventions (per-agent, not shared) trace back to this phase's
groundwork.

**P9 — Scoped git tool, done then removed.** Added a `git` tool with a
curated allowlist (status/diff/log/show/add/commit/branch) run via
`execFile` (no shell). Removed once P4's shell gate was gone: a scoped
allowlist added no real safety over an already-ungated `run_shell` while
costing a whole tool slot. Git is reached via `run_shell` today.

**P10 — Context-window management.** `agent/context/`'s `ContextManager`
keeps requests within the model's window without a tokenizer dependency: a
cheap `~chars/4` estimate calibrated against the provider's real
`usage.input_tokens`, proactive pruning of old tool outputs, then
model-call compaction into a structured summary once the estimate crosses
`compactAt` of budget, and a bounded overflow-retry/circuit-breaker path for
when a request still exceeds the window. `/compact` (manual) and `/context`
(usage report) REPL commands. The in-session task list survives compaction
since it lives outside `history`.

**P11 — File lifecycle + background processes.** Added `move_file`,
`copy_file`, `delete_file`, `make_dir`, and background-process control
(`run_process`/`read_process`/`kill_process` via a module-level
`ProcessManager`, killed on session exit). The four file-lifecycle tools were
later removed, along with `stat` and `list_dir`: neither claude code nor
opencode has them (both use the shell, and opencode's `read` lists
directories), and they added no safety over the ungated `run_shell` — the same
reasoning that removed P9's `git` tool. `read_file` lists directories;
everything else goes through `run_shell`. The background-process tools stay.

**A3 — Max output tokens recovery.** When a turn's response is truncated
(`incomplete_details.reason === 'max_output_tokens'`), `agent/loop.ts`
replays the truncated output into history, injects `{role: 'user', content:
'Continue.'}`, and retries up to `CONTINUE_RETRIES = 3` times, resetting on
any non-truncated response.

**A7 — Multi-retry compaction.** Widened the single compact-and-retry path
on a context overflow into a bounded loop (`OVERFLOW_RETRIES = 3`),
independent of `ContextManager`'s own circuit breaker (which tracks
consecutive compaction failures, not retry attempts). Also widened
`isContextOverflowError` to recognize plain `Error` objects with `status ===
413`, not just `OpenAI.APIError` instances, for non-OpenAI providers and
test mocks.

**Landed outside the numbered phases** (each already summarized in §8; no
new locked decisions):

- **Streamed markdown rendering** (`ui/markdown.ts`) and the **compact
  per-query tool summary** (`ui/tools.ts`) — see §5's Architecture notes for
  how both work today.
- **`ask_user`** (`tools/local/question.ts`) — interactive questions via
  `@clack/prompts`; refuses immediately (rather than hanging) when stdin
  isn't a TTY.
- **Sub-agents** (`agent/subagent.ts` + `tools/local/task.ts`) — the `task`
  tool runs a nested `runAgent` with a filtered tool registry (`explore`
  read-only via an allow-list, `general` everything-but-`task` via a
  deny-list so it can't silently go stale as tools are added), its own
  `TaskStore`, a silent sink, and a nesting depth limit of 1. See
  ONBOARDING.md's Sub-agents section.
- **Global API-key storage** (`cli/keys.ts`, the `/key` command) — persists
  `apiKey`/`braveApiKey` into `~/.config/dcode/dcode.json` (`0600`, directory
  `0700`) so a globally installed dcode doesn't need per-shell env vars.
- **REPL tab-completion** (`cli/completer.ts`) — slash commands from the
  known list; otherwise the last token completes as a `resolvePath`-confined
  file path.
- **`/save`/`/limit`** — `/save [path]` writes the transcript (Markdown for
  `.md`, verbatim JSON otherwise), refusing to overwrite; `/limit <n>` sets
  `maxToolIterations` at runtime.
- **Dropped `.env` auto-loading and repo-local `./dcode.json` discovery** —
  dcode is a globally installed personal tool, so config resolution is
  exactly `CLI > env (process) > global ~/.config/dcode/dcode.json > schema
  defaults`; no cwd-relative config files are auto-discovered.
