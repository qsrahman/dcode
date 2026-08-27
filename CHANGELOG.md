## [0.13.7] - 2026-08-27

### Added
- Global API-key storage for installed-anywhere use (`src/cli/keys.ts`, new). A
  globally installed dcode can persist secrets so they apply from any directory
  without per-shell env exports or hand-editing JSON:
  - `/key set openai <key>` and `/key set brave <key>` write the key to
    `~/.config/dcode/dcode.json` (relocatable via `DCODE_CONFIG_HOME`) with the
    file at `0600` and its directory at `0700`.
  - `/key list` shows which providers are set without revealing values;
    `/key unset <openai|brave>` clears one. Setting a key also updates the live
    session config so it takes effect immediately.
  - A small provider allowlist (`openai` → `apiKey`, `brave` → `brave`) keeps
    `/key` from writing arbitrary config keys.
- `schema.ts` adds a `brave` field; `web_search` reads `ctx.config.brave ??
  process.env.BRAVE_API_KEY`, so Brave search works from stored config.
- `/config` prints a redacted `keys: openai=set brave=unset (values hidden)`
  line. Key precedence: CLI > env > local config > global config > default.

## [0.13.6] - 2026-08-27

### Added
- REPL UX enhancements (`src/agent/loop.ts`, `src/cli/completer.ts`):
  - Richer tool-status lines: the tool name is colored, the ✓/✗ status stays
    green/red, and the duration is dimmed. Stripped text is unchanged, so the
    model-fed contract holds.
  - Colored diff preview in verbose mode: unified-diff lines are colored (hunk
    headers cyan, `+` green, `-` red), lighting up `git diff` and any diff
    output. `edit_file` output stays `edited <path>` (no diff in the tool
    result — purely a display change).
  - REPL tab-completion (`src/cli/completer.ts`, new; wired into `startRepl`):
    slash commands complete from the known list; otherwise the last
    whitespace-delimited token is completed as a path under the working
    directory, confined via `resolvePath` so it can't suggest escapes.
  - PLAN.md §22 documents the enhancement.

## [0.13.5] - 2026-08-27

### Added
- File-lifecycle tools (`src/tools/local/fs.ts`): `make_dir`, `move_file`
  (rename, creates the destination parent), `copy_file`, and `delete_file`
  (refuses to delete the working-directory root; `recursive` for directories).
  All `resolvePath`-confined with structured `fsError` messages.
- Background-process tools (`src/tools/local/process.ts`, new):
  `run_process` spawns a long-running command and returns a handle + pid;
  `read_process` tails its buffered output and reports running/exited;
  `kill_process` stops it (SIGTERM default). Children run detached in their own
  process group (group-killed), scrub secrets via `safeEnv`, confine `cwd` to
  the root, cap buffered output at 64 KB, and are killed on session abort and
  at process exit.
- System prompt accuracy: immediate-effect/no-revert list now covers the new
  file tools; added `run_process`/`kill_process` guidance and a note to prefer
  dedicated filesystem tools over `run_shell`.
- PLAN.md: tool roadmap (Tiers 1–4) and a P11 specification for these tools.

## [0.13.4] - 2026-08-27

### Added
- Filesystem tools are more robust and useful (`src/tools/local/fs.ts`, `src/tools/local/search.ts`):
  - `read_file`: `offset`/`limit` line paging and optional 1-based `line_numbers` (default on); still caps reads at `maxToolOutputBytes`.
  - `write_file`: creates parent directories, supports `append`, and takes `overwrite` (default `true`; `false` refuses to clobber).
  - `list_dir`: sorted (directories first), marks symlinks with `l`, and caps entries with a footer.
  - `grep`: `ignore_case` and `context` (±N lines) options.
  - `glob`: caps results (with footer) plus a `limit` and multiple patterns (`pattern: string[]`).
  - `stat`: reports line count for small text files and a symlink `target`.

### Changed
- Hardened shell/git execution (`src/tools/local/exec.ts`, `git.ts`, `shell.ts`):
  - Children no longer inherit secret env vars (`OPENAI_API_KEY`, `BRAVE_API_KEY`, …); `PATH`/`HOME`/`LANG` are kept.
  - Clear errors for over-sized output (`command output exceeded …`) and timeouts/aborts (`timed out`/`aborted`) instead of cryptic codes.
  - `git add` now requires one or more `paths` (no more silent `git add -A`) and uses a `--` separator.
  - Dropped redundant `execute` param type annotations (generic already types them).
- System prompt accuracy: file-reads line notes the size cap + paging; `write_file` line notes `append`/`overwrite`.

## [0.13.3] - 2026-08-27

### Changed
- Harden filesystem tools (`src/tools/local/fs.ts`):
  - `read_file` reads at most `maxToolOutputBytes` (was buffering the whole file, risking OOM on huge/symlinked files) and notes truncation.
  - `read_file` and `edit_file` now detect binary content (NUL sniff) and refuse/cap it instead of dumping or corrupting mojibake.
  - `write_file` routes write failures through `fsError` for consistent, self-correcting messages (was letting raw Node errors through).
  - Simplified: dropped redundant `execute` param type annotations; `stat` uses `Stats` instead of `Awaited<ReturnType<typeof stat>>`.

## [0.13.2] - 2026-08-27

### Added
- `web_fetch` tool: fetch a URL and return its content as text. HTML is converted to Markdown (via `node-html-markdown`), JSON is pretty-printed, other text is passed through, and binary payloads are described rather than dumped. No API key required (unlike `web_search`). Only `http`/`https` schemes are allowed; `ctx.signal` is forwarded so in-flight fetches cancel on Ctrl-C; failures become `ok:false` outcomes the model can self-correct from.

## [0.13.1] - 2026-08-27

### Changed
- Hardened the agent system prompt (`src/agent/system.ts`): fixed the inaccurate
  "there is no undo" claim (the `/undo` command only drops the last conversation
  exchange, it does not restore changed files); added git/VCS discipline (no
  commit/push/branch/force unless explicitly asked); added a destructive-shell
  guardrail; required reading a file before editing it; broadened the
  untrusted-data rule to cover command injection; and added plan-before-large
  changes, stop-on-repeated-failure, and no-fabrication rules. The prompt is now
  organized into Tool use / Planning / Security / Style sections.

## [0.13.0] - 2026-08-27

### Added
- Missing-key guidance: when `OPENAI_API_KEY` is unset, dcode prints setup
  instructions (shell profile / `.env` / `dcode.json`) and exits 1 instead of
  starting and failing later.
- Pre-flight API-key validation: before starting, dcode probes
  `{baseURL}/models` with the key and, on `401`/`403`, prints an
  "OPENAI_API_KEY is invalid (authentication failed)" message and exits 1 so a
  bad key fails fast with a clear cause rather than hanging on the first query.
- Global config fallback: when no local `dcode.json`/`.dcode.json` is found,
  config falls back to `~/.config/dcode/dcode.json` (overridable via
  `DCODE_CONFIG_HOME`), convenient for the globally installed `dcode`. Local
  config wins over global; an explicit `--config` path is used alone.

### Fixed
- The globally installed `dcode` (`pnpm add -g`) silently exited 0 and never
  started: the entry-point guard compared `import.meta.url` to `argv[1]` without
  resolving symlinks, and pnpm reaches the global install through symlinks, so
  the comparison failed and `main()` was never called. The guard now resolves
  symlinks via `realpathSync`.

## [0.12.1] - 2026-08-27

### Fixed
- Context compaction no longer wipes the conversation history. `ContextManager.compact`
  replaced the history in place via `length = 0` + `push(...next)`; when compaction was a
  no-op (nothing to summarize) `compactHistory` returned the live `history` array by
  reference, so clearing it left `next` empty and the next request went out with no
  messages — which some endpoints answered with a non-conformant `output` that crashed the
  SDK (`rsp.output is not iterable`). `compact` now uses `splice` to replace in place.
- Compaction summarization is sent as a `user` input message (and the summary is injected
  as `user`), not `developer`/`system`. Several OpenAI-compatible / local endpoints reject
  those roles as input and return a non-conformant `output` shape the SDK can't parse, so
  the previous `developer` → `system` → `user` fallback (which only triggered on HTTP 4xx)
  never engaged and crashed. The summary message role in compacted history is now `user`.

## [0.12.0] - 2026-08-27

### Changed
- Context compaction is now **proactive**: `ContextManager` triggers prune + LLM
  summary once the estimate crosses `context.compactAt` (default 0.85) of the
  usable budget, instead of only at the hard window limit, so long sessions stay
  under the context window without hitting a context-length error and retrying.
- Compaction is now **todo-aware**: the session's authoritative `todo` task list
  (`TaskStore`) is appended to the summarization instruction, so the summary
  cannot drift from or contradict the tracked tasks. Optional — one-shot runs
  without a task list summarize as before.
- Added `context.compactAt` config (0..1, default 0.85).

## [0.11.0] - 2026-08-27

### Changed
- `run_shell` and `git` now share a `runExec` helper (`tools/local/exec.ts`)
  for the `execFile` timeout/signal/buffer options and success/error output
  formatting, instead of duplicating that logic in both tools.
- The three task tools (`task_create` / `task_list` / `task_update`) are
  consolidated into a single `todo` tool (actions: add / list / update / done)
  that wraps the `TaskStore`. The system prompt and the REPL (`/todo`, alias
  `/tasks`) now reference `todo`; `TaskStore` behavior is unchanged.
- System prompt: reference the real `todo` tool by name and add a no-secrets
  rule (never echo API keys, tokens, or passwords in responses).

## [0.10.0] - 2026-08-25

### Added
- REPL slash commands for visibility and recovery:
  - `/tasks` lists the in-session task list (backed by `TaskStore`).
  - `/config` prints the effective configuration (model, baseURL, limits,
    context-window settings).
  - `/undo` removes the last user exchange (prompt + response) so a bad turn can
    be discarded without `/reset`ting the whole conversation.
  - `/verbose` toggles verbose mode at runtime (`/verbose on|off`).

### Fixed
- `/reset` now clears the conversation entirely. It previously kept `history[0]`,
  which after the `instructions` refactor no longer held the system prompt, so it
  would retain a stale item instead of resetting.

## [0.9.0] - 2026-08-25

### Changed
- The system prompt is now sent via the Responses API `instructions` field
  instead of being prepended as a `system` role item in the conversation
  `history`. `history` is now purely the conversation, which simplifies trimming
  and keeps the durable guidance separate from turn input.
- `compactHistory` no longer assumes `history[0]` is the system message; it
  summarizes the conversation body directly (the system prompt is carried by
  `instructions`). The injected summary remains a single message at the head of
  the compacted history.

### Added
- `stateful` config flag (default `false`). When `true`, responses are stored
  server-side (`store: true`) so a later turn could chain via
  `previous_response_id`. Off by default to avoid OpenAI's 30-day retention and
  to keep local/compatible endpoints (which don't persist responses) working.
  When `false` against OpenAI (no custom `baseURL`), `store: false` is sent
  explicitly.

## [0.8.0] - 2026-08-23

### Fixed
- Schema validation now enforces `keepTokens < window - reserved` to prevent
  infinite compaction loops when context-window config is misconfigured.
- `truncate()` no longer splits multi-byte UTF-8 characters; it walks backward
  to the nearest valid character boundary before cutting.

### Changed
- Deduplicated `SHELL_MAX_BUFFER` / `GIT_MAX_BUFFER` (10 MiB) into a shared
  `CHILD_MAX_BUFFER` constant in `tools/local/constants.ts`.
- Brave Search API endpoint is now configurable via `BRAVE_ENDPOINT` env var.
- Simplified `withDeadline` to use `AbortSignal.timeout()` + `AbortSignal.any()`
  instead of manual `setTimeout`/`addEventListener` logic.
- Command dispatch in `cli/commands.ts` refactored from a `switch` to a
  `Record<string, CommandHandler>` map for easier extensibility.

### Added
- New `tools/local/constants.ts` module for shared child-process buffer ceiling.

### Added
- Context-window management: dcode now keeps each request within the model's
  context window instead of relying on a naive item-count trim. Before every
  request it prunes old tool outputs (collapsing them to a short marker) and, if
  still over budget, summarizes the oldest history into a single `developer`
  message while keeping a recent tail verbatim (`compactHistory`). A context-
  window overflow (OpenAI 413 / `context_length_exceeded`) triggers a compact
  and a single retry, guarded by a circuit breaker after 3 consecutive failures.
- Token estimate is calibrated against the real `usage.input_tokens` the
  Responses API returns, so no tokenizer dependency is added.
- `context` config block: `window` (model limit, default 200000), `reserved`
  (headroom for output + compaction, default 20000), `keepTokens` (recent tail
  kept verbatim, default 15000), `auto` and `prune` toggles.
- REPL commands `/compact` (manual summary) and `/context` (usage report).

### Changed
- `client.stream` gains a `maxOutputTokens?` option (used to cap compaction
  output at 4096) and exposes `isContextOverflowError`.
- The agent loop now drives a session-scoped `ContextManager` (`beforeTurn`
  pre-request, `observe` post-response) for both REPL and one-shot runs.

## [0.6.0] - 2026-08-23

### Added
- `git` tool: a scoped, shell-free interface for the common, safe git operations
  (`status`, `diff`, `log`, `show`, `add`, `commit`, `branch`), confined to the
  working directory. Remote and destructive commands (push, pull, reset,
  checkout, clean, merge, rebase) are intentionally unsupported — `run_shell`
  remains the escape hatch for those.

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
