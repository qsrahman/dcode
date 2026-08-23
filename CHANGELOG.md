# Changelog

All notable changes to **dcode** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-08-23

### Added
- In-session task list: `task_create`, `task_list`, and `task_update` tools let
  the model plan and track work during a run. Tasks get sequential ids (T1, T2…)
  with a status (`pending` / `in_progress` / `completed` / `blocked`) and optional
  `blockedBy` dependencies. State is in-memory only and is cleared by `/reset`.

## [0.4.1] - 2026-08-22

### Changed
- REPL: lines typed while a turn is running are queued and executed in order
  when it finishes, instead of being silently dropped; a queued `/exit` still
  quits. The startup hint (`Ask anything, /help for commands...`) now prints
  once at startup rather than repeating above every prompt.
- `--verbose` tool echoes are fenced between dim rules naming the tool, so raw
  dumps don't read as more streamed model text.
- Failed tool calls render `✗ failed` instead of `✗ done`.
- `write_file` reports true byte length (`Buffer.byteLength`) instead of JS
  string length (they differ for non-ASCII content).
- `grep` skips binary files — a NUL byte in the leading chunk (git's heuristic)
  — instead of decoding them into garbage match lines.
- Internal: `runTurn`/`runOneShot`/`handleLine` take a single opts object
  instead of positional params with interleaved defaults; `createClient(config)`
  no longer takes a logger (its per-turn debug log duplicated `runTurn`'s);
  `runTurn` clears its `StreamRef` once the stream completes; post-tool turns
  stream live to the sink instead of buffering through `CapturingSink`.

### Fixed
- `edit_file` substitutes `new_string` literally in both branches:
  `String.replace` interpreted `$&`-style replacement patterns and could
  silently corrupt files whose content legitimately contains them (shell
  scripts, Makefiles), disagreeing with the `replace_all` branch's literal
  split/join.
- `web_search` failures (missing key, network error, non-OK status) throw like
  every other tool and surface as ok:false outcomes; previously they returned
  error strings rendered as successful `✓ done` lines.

### Removed
- The unused `mcp` config schema: validated on load but consumed by nothing;
  P6 will reintroduce config alongside the MCP manager itself.

## [0.4.0] - 2026-08-22

### Added
- `web_search` tool (Brave Search API; `BRAVE_API_KEY` required) joins the
  built-in tool set, assembled by the `createLocalTools` hub.
- One-shot mode (`dcode [prompt]`) now handles Ctrl-C gracefully: a `SIGINT`
  aborts the in-flight model stream instead of killing the process.

### Changed
- Removed the permission/harness gate (P5 cancelled); all tools are now
  auto-approved. `agent/gate.ts` is gone and `ToolDefinition` no longer carries a
  `mutates` flag.
- Tool layer restructured: `tools/local.ts` split into `tools/local/`
  (`paths`, `traverse`, `fs`, `search`, `shell`, `web`, `index`);
  `createLocalTools()` remains the single hub that assembles them into the
  `ToolRegistry`.
- Renamed env var `OPENAI_DEFAULT_MODEL` → `OPENAI_MODEL`.

### Removed
- The `--mode`/`--auto`/`--plan` CLI flags and `config.permissions` (both
  belonged to the cancelled P5).

### Added (from prior unreleased work)
- `ignore` config field (default `['.git', 'node_modules']`): `grep` and `glob`
  now prune these directory names during traversal instead of walking the whole
  tree, so searches on a real repo return source matches rather than dependency
  noise. `grep` also caps output at 200 matches with a truncation note.
- Ctrl-C now cancels an in-flight tool, not just the model stream. The abort
  signal is threaded through `runTool` (which races against it) into
  `ToolContext.signal`, and `run_shell` forwards it to the child process so it
  is actually killed. The loop only aborts after each call has a recorded
  output, so conversation history stays balanced and resumable.

### Security
- Closed a symlink path-traversal escape. Path confinement was purely lexical,
  so a symlink inside root pointing outside it (e.g. `root/link → /etc`) passed
  the check and let `read_file`/`write_file`/`edit_file` follow it out of the
  working directory. `resolvePath` now also canonicalizes with `realpath`
  (tolerating a not-yet-created leaf) and re-checks confinement, and `walkDirs`
  skips symlink entries entirely so `grep`/`glob` can't read through them.

### Fixed
- `trimHistory` no longer risks orphaning a tool call from its output. It now
  advances the cut point to a message boundary, so it never retains a
  `function_call_output` whose `function_call` was trimmed (or vice versa),
  which the Responses API rejects.
- Restored a `maxBuffer` bound on `run_shell` (10 MiB) that the fs/mutate merge
  had dropped, so very large output is bounded rather than relying on the
  default.

## [0.3.0] - 2026-08-18

### Added
- Mutating local tools join the read-only set: `write_file` (create/overwrite a
  file), `edit_file` (literal old/new string replace; requires a unique match
  unless `replace_all`), and `run_shell` (arbitrary shell command with
  `cwd=root` + `toolTimeout`, capturing combined stdout/stderr) — all in
  `tools/local/mutate.ts`, reusing the `resolvePath` root-confinement helper
  exported from `tools/local/fs.ts`.
- Harness gate (`agent/gate.ts`) decides per-call whether a tool runs: the
  default deny gate (one-shot) blocks mutating calls, the confirm gate (REPL)
  prompts `y`/`n`/`a` per mutating call (with `a` approving the rest of the
  session), and an allow gate auto-approves. `ToolDefinition` gains a `mutates?`
  flag.
- `agent/loop.ts` now splits a turn's tool calls into read-only (run in
  parallel) and mutating (run sequentially, each harness-gated), preserving the
  original call order in history. `/tools` annotates mutating entries with ` *`.

### Changed
- `agent/system.ts`'s base system prompt now describes the inspect-and-modify
  scope (prefer `edit_file`, mutating tools may need approval) instead of the
  old read-only "you cannot modify files" wording.
- `cli/repl.ts`'s `startRepl` drives input via `rl.on('line')` (with a
  `pendingGate` resolver so a gate confirmation is answered on the next line
  without being treated as a new command) and resolves only when the REPL
  closes, rather than a `for await` over the readline iterator.
- `cli/commands.ts`'s `Session` now carries the `gate`; `createSession` accepts
  it (defaulting to allow) and `startRepl` wires the confirm gate.

### Added (from prior unreleased work)
- Tools: `stat` (type/size/mtime of a file or directory) and `glob`
  (recursive `**`-pattern file matching, hand-rolled glob→RegExp, no new
  dependency) join `read_file`/`list_dir`/`grep` in `tools/local/fs.ts`.
- `--verbose` now also echoes each tool call's raw output to the terminal
  (previously only the `› name: ✓ done (Ns)` status line was shown).

### Changed
- `tools/registry.ts#toResponsesTool` now converts zod schemas to JSON Schema
  via zod v4's built-in `z.toJSONSchema`, replacing the hand-rolled converter
  originally specified for P3 (PLAN.md §11.12).
- A missing default config (`dcode.json`/`.dcode.json`) still falls back to
  schema defaults, but an explicit `--config <path>` that doesn't exist now
  throws instead of being silently ignored (`config/config.ts#loadConfig`).
- `pnpm stress` runs a live end-to-end stress test (`scripts/live-stress.ts`)
  that drives the real agent loop and fs tools against the configured model;
  `scripts/**/*.ts` is now included in the typecheck gate.
- `dcode`'s own `Tool` interface (`agent/types.ts`) renamed to `ToolDefinition`
  to stop colliding by name with `openai`'s `Tool` type (the Responses API's
  wire-format tool shape), which every import site already aliased as
  `ResponsesTool`. No behavior change.
- `agent/run.ts#runTurn` no longer reconstructs the final text by
  concatenating streamed deltas itself; it now returns the SDK's own
  `Response.output_text` (from `stream.finalResponse()`) — the same
  aggregation the SDK already computes internally from the same delta
  events, so the delta loop now exists purely for live rendering.
- `tools/local/fs.ts`'s directory walk was factored into a shared `walkDirs`
  generator (renamed from `walk`) used by `grep` and `glob`, and `ToolRegistry`
  now caches its converted Responses tool list instead of rebuilding it.
- The `/tools` REPL command now prints a single compact `Tools: a, b, c` line
  instead of one verbose `name — description` line per tool (`cli/commands.ts`).
- The live stress script (`scripts/live-stress.ts`) now captures the agent
  loop's rendered output per scenario and asserts UI/UX spacing (exactly one
  well-formed, line-separated status line per tool call).

### Fixed
- `grep` now returns paths relative to the working directory root, matching
  `list_dir`/`glob` and the system prompt's own "pass paths relative to its
  root" instruction — it previously leaked absolute host filesystem paths.
- `grep`'s directory walk no longer follows symlinks (avoiding infinite
  loops) and no longer crashes on unreadable/binary files; `tools/index.ts`
  falls back gracefully if zod schema conversion fails for a tool.
- `agent/system.ts`'s base system prompt no longer hand-lists tools (the SDK
  supplies each tool's name/description/arguments to the model); it now only
  describes the read-only working-directory scope.
- Tool outputs from multi-turn tool calls are now grouped into a single block
  with exactly one blank line separating them from the final answer; previously
  each tool turn appended its own trailing blank, leaving blank lines between
  individual tool results (`agent/loop.ts`).
- `runTool` now validates model-supplied tool-call arguments against the
  tool's zod schema before executing and returns a model-readable error
  instead of throwing raw exceptions on malformed args.
-   `config/config.ts#loadConfig` now parses `dcode.json` with
  `configSchema.strict()` instead of `.partial()`. The `.partial()` call
  was a no-op (every field already tolerates absence via `.optional()`/
  `.default()`) and, worse, silently accepted typo'd/unknown keys (zod's
  default object mode strips unrecognized keys); a typo like `"modle"` now
  fails loudly instead of silently falling back to defaults.

## [0.2.0] - 2026-08-17

### Added
- System prompt: `agent/system.ts` defines a base system message injected
  into every run (`buildSystemPrompt`), stating dcode's role, working-directory
  scope, and that tool output is untrusted data.
- Diagnostics logger: `util/log.ts` exposes `createLogger(config)` with
  `debug`/`info` (verbose-gated) and `warn`/`error` (always to stderr), colored
  via the `ansis` dependency. It is the single diagnostics channel: `index.ts`
  routes arg-parse/config/run errors through it (with a fallback logger so
  setup failures are never raw stack traces), and `client.ts`/`run.ts` emit
  `debug` lines for each request/run.
- REPL: `cli/repl.ts` starts an interactive session (`startRepl`) with a
  module-local `Session` (type + slash-command `parseCommand`/`dispatch` live
  in `cli/commands.ts`), slash commands (`/help` `/model` `/clear` `/reset`
  `/version` `/exit`), capped multi-turn history (decision B), Ctrl-C abort of
  the in-flight stream (decision L), and reuses the `runTurn` turn runner from
  `agent/run.ts`. `/mode` remains deferred (P5).
- REPL: `/model` with no argument prints the current in-use model; `/model <id>`
  still switches it.
- REPL prompt now shows a persistent `Ask anything, /help for commands...` hint
  above a `>` prompt on each turn.
- Tools + agent loop (P3): `tools/` defines read-only tools (`read_file`,
  `list_dir`, `grep`) confined to `root`, a `ToolRegistry`, and a hand-rolled
  zod→JSON-Schema converter (`strict: false`, no new dependency). `agent/loop.ts`
  runs the agentic loop — stream, execute tool calls in parallel, feed results
  back, repeat up to `maxToolIterations` — while `agent/run.ts#runTool` applies
  `toolTimeout` and truncates output to `maxToolOutputBytes`. `/tools` lists
  available tools in the REPL.

### Changed
- Version is read from package.json at runtime via `createRequire` instead of
  a hardcoded constant in `index.ts`.
- REPL `/help` output is now dimmed and reformatted (header `Commands:`, a
  trailing blank line), keeping commands alphabetically sorted. The `Ask
  anything, /help for commands...` hint above the prompt is left unstyled.
- REPL slash-command responses (e.g. `/model`, `/reset`, `/version`) now end
  with a blank line for visual separation.

### Fixed
- `createClient` now applies `config.maxRetries` to the OpenAI client and
  `config.maxTokens` as `max_output_tokens` on each request; both were defined
  in the schema but previously ignored. (`toolTimeout` stays unused until P3,
  where it gates per-tool execution, not the SDK request.)
- REPL's `showPrompt()` no longer crashes with `ERR_USE_AFTER_CLOSE` when piped
  (non-TTY) stdin reaches EOF while a turn is still streaming — a real bug
  found via a live stress test against a real model endpoint, which silently
  dropped the rest of piped input after the first turn.

### Removed
- Non-streaming support. `dcode` now always streams model output: the
  `Client.complete` method, the `config.stream` field, and the `--no-stream`
  flag were removed. The OpenAI Responses client wrapper is streaming-only
  (`agent/client.ts`), and `runTurn` always streams deltas to `sink`.

## [0.1.0] - 2026-08-17

### Added

- Config layer: zod schema (`config/schema.ts`), JSON file loading, and a pure
  CLI > env > file > defaults merge (`config/config.ts`).
- CLI argument parsing (`cli/args.ts`): `--model/-m`, `--mode`, `--auto`,
  `--plan`, `--config/-c`, `--no-color`, `--verbose`,
  `--version/-v`, `--help/-h`, plus a positional one-shot prompt.
- OpenAI Responses client wrapper (`agent/client.ts`): streaming, behind
  the `Client` interface for testability.
- One-shot run orchestration (`agent/run.ts`) and the `dcode [prompt]` path in
  `src/index.ts`. REPL is deferred to P2.

## [0.0.0] - 2026-08-17

### Added

- Project scaffold: `package.json` (pnpm, ESM, `bin`), `tsconfig.json`
  (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`), Prettier config,
  `.gitignore`, Vitest config.
- Authoritative docs: `PLAN.md` (PRD + phase plan + locked decisions),
  `README.md` (usage), `AGENTS.md` (developer guide), `CHANGELOG.md`.
- Minimal runnable entry (`src/index.ts`) printing version/`--version`.
- Toolchain contract test asserting Node.js 26+ (`tests/tooling.test.ts`).
