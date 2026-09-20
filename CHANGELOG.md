## [Unreleased]

### Added
- REPL: the prompt is now two lines — a dim status line (`model · turn N ·
  ↑in ↓out · used/usable (pct% used)`) above the usual `> ` input marker —
  rebuilt before every `rl.prompt()` call so it's never more than one turn
  stale. No new dependency: readline's own multi-line prompt support does
  the rendering. `AgentResult` (`agent/loop.ts`) gained optional
  `inputTokens`/`outputTokens` from the final turn's `response.usage` to
  feed it, and `Session` (`cli/commands.ts`) gained `lastUsage` (the turn
  count is derived from history, skipping the injected `Continue.` retries via
  `isUserPrompt`). `lastUsage` is cleared by `/undo`, `/reset`, and a failed or
  aborted turn.

### Changed
- System prompt revised against OpenAI's GPT-5/5.1 and Anthropic's prompting
  guidance:
  - New "Completing the task" section: keep going until the request is
    resolved, run the project's checks after changing code (and say so when
    they can't be run), fix root causes rather than special-casing tests.
  - Style: don't narrate between tool calls (the terminal already shows tool
    progress, and `onBeforeText`'s summary freeze assumes tool turns emit no
    text), and end tool-using tasks with a short what-changed/what-verified
    summary.
  - Contradictions resolved: the ask-vs-assume bullets are merged, the
    "outline before editing" step now goes through `todowrite` instead of
    visible text, "inspect first" gains a stop-searching criterion, and the
    duplicated no-guessing and git-history lines are folded.
  - Per-tool usage detail (`edit_file`/`write_file` semantics, read caps) is
    dropped from the prompt — the tool descriptions already carry it — leaving
    only cross-cutting policy; a scope guard (no unrequested refactors, extra
    abstractions or files; match project style; clean up scratch files) is
    added, and a few bare rules gain a one-clause reason.
  - `Platform: <os>` is added beside the working directory and date, since
    `run_shell` behaviour differs between macOS and Linux.
- **Breaking:** the `brave` config key (Brave Search API key) is renamed
  `braveApiKey`, matching `apiKey` and `braveEndpoint`. A `dcode.json` still
  using `"brave"` now fails the strict config parse — rename it, or re-run
  `/key set brave <key>` (the `/key` provider name is unchanged).
- System prompt (`agent/system.ts`) synced with the current tool set and
  sub-agent behavior:
  - The tool-use section now names `read_process` alongside `run_process`/
    `kill_process` — the same stateful start/poll/stop workflow, previously
    missing its middle step.
  - `buildSystemPrompt` now takes an optional `{ subagents?: boolean }` and
    the prompt is composed from `CORE_SYSTEM_PROMPT` + a conditional
    `SUBAGENT_SECTION` + `STYLE_SECTION` (`BASE_SYSTEM_PROMPT` — the full,
    default-`subagents: true` concatenation — stays exported as before, so
    every existing caller is unaffected).
  - The `general` sub-agent type now builds its prompt with
    `subagents: false`: `task` is denied by its own `ToolPolicy` and
    rejected again by `task.ts`'s `MAX_DEPTH` even if it weren't, so
    reusing the full base prompt (as it did before) told a `general`
    sub-agent to delegate to a sub-agent of its own — dead, actively
    misleading instructions for a role that structurally cannot do that.
    `explore` is unaffected (it already has its own dedicated prompt, not
    the base one).
- Startup now logs a warning when `maxTokens >= context.reserved`
  (`configWarnings` in `config/config.ts`). `context.reserved` is headroom for
  *both* the model's own output and the separate compaction call, so
  `maxTokens` — the ceiling on that output — should leave real room under it.
  It is a warning, not a validation error, so an existing `dcode.json` that
  raised `maxTokens` still loads.
- All `zod` imports now come from `zod/v4` explicitly (previously bare
  `'zod'`, which resolves to the same v4 API today but isn't pinned against
  a future major changing what the bare specifier means).
  `web_fetch`'s URL argument, `baseURL`, and `braveEndpoint` now validate as
  real http(s) URLs via zod's own `z.url({ protocol: /^https?$/ })` instead of a hand-rolled
  `new URL()` try/catch plus a manual scheme check (`web_fetch`) or no
  validation at all (`baseURL`/`braveEndpoint` previously accepted
  any string and only failed later, as an opaque native `TypeError`, the
  first time something tried to actually use it). `web_fetch`'s scheme/parse
  errors now surface through `runTool`'s normal `ok:false` path (parameter
  validation, not a thrown error from inside `execute()`), and `baseURL`/
  `braveEndpoint` typos are caught at config-load time with a clear message
  naming the field. MCP remote `url` stays a plain string on purpose: a bad
  one fails only that server at connect time, never all of config loading.
- `runAgent`/`runOneShot` now return `{ text, truncated }` instead of a bare
  string. `truncated` is true when the loop stopped because it hit
  `maxToolIterations` with tool calls still pending, not because the model
  finished on its own — previously this was only visible as a
  `logger.warn` line, easy to miss outside `--verbose`. **Breaking** for any
  code calling `runAgent`/`runOneShot` directly and treating the result as a
  string.
  - The REPL now prints an explicit, user-facing hint on `sink` when this
    happens: raise `/limit <n>` and send a follow-up to resume — the
    conversation's `history` is already left fully resumable (every
    executed tool call is paired with its output before the cap is
    checked), this was previously discoverable only by accident.
  - The `task` tool now flags a truncated sub-agent result as incomplete in
    what it hands back to the parent model, since a sub-agent session can't
    itself be resumed (see `task.ts`'s module comment).
  - `/continue` — resuming without a throwaway follow-up prompt — is noted
    as a deferred REPL command in PLAN.md §10, not yet implemented.
- `run_shell`/`grep`/`glob`'s child-process buffer ceiling
  (`tools/local/exec.ts`'s `CHILD_MAX_BUFFER`) is now derived from
  `maxToolOutputBytes` instead of a fixed 10 MiB constant, via the new
  `childMaxBuffer(maxToolOutputBytes)` — `Math.max(10 MiB, maxToolOutputBytes
  * 4)`. Previously, raising `maxToolOutputBytes` past 10 MiB silently
  stopped working as documented: instead of a clean truncation-with-note,
  `run_shell`/`grep` would hit the fixed ceiling first and fail with an
  opaque `execa` maxBuffer error. Not a new config field — a second,
  independently-set number whose only job is "stay bigger than
  `maxToolOutputBytes`" would just be a second thing to keep in sync by
  hand; deriving it keeps that invariant enforced by code instead. No
  behavior change at the default (32 KiB `maxToolOutputBytes` still yields
  the 10 MiB floor).

## [0.18.0] - 2026-09-15

### Changed
- The live stress script (`scripts/live-stress.ts`) now connects the
  configured MCP servers before assembling its tool registry and reports
  their status at startup, matching `index.ts`/`repl.ts`'s own sequence —
  it had drifted since P6 landed and was only exercising the built-in
  tools. `formatMcpServers` (`cli/commands.ts`, the `/mcp` command's
  formatter) is now exported so the script reuses it instead of
  re-deriving the same status text.
- Agent loop: a max-output-token truncation now replays the truncated partial
  response (via `pushResponseOutput`, tool calls excluded — a call cut off
  mid-truncation is never executed, so replaying it would leave a
  `function_call` with no matching `function_call_output`) into history
  before injecting `Continue.`, so a retry is grounded in what was already
  produced instead of re-answering from scratch — and a `Continue.` retry
  that itself overflows the context window is recovered through the same
  compact-and-retry path as the initial request (see PLAN.md §11's A3/A7
  entries).
- MCP `mcpServers` config: the `type` discriminant is now `"local"` /
  `"remote"` instead of `"stdio"` / `"http"` — clearer for a config field the
  average user sets (or omits and lets infer), the underlying-transport name
  stays where it belongs, in the code that actually talks stdio/HTTP.
  Inference from `command`/`url` is unaffected. **Breaking:** an explicit
  `"type": "stdio"` or `"type": "http"` in `dcode.json` is now rejected by
  the strict parse — switch to `"local"`/`"remote"`, or just omit `type` and
  let it infer.

### Added
- MCP `mcpServers` config: a `headers` (http) or `env` (stdio) value that is
  *exactly* `${VAR_NAME}` is expanded from `process.env` at connect time —
  never persisted, never logged — so a server's secret (e.g. an API key) can
  live in the shell instead of sitting in `dcode.json` in the clear, the same
  principle `/key` already serves for the OpenAI/Brave keys. Whole-value-only
  (no partial interpolation inside a larger string). An unset referenced
  variable fails just that one server's connection with a clear error naming
  the variable, rather than sending a literal `${VAR}` or blocking startup
  for every other configured server. See `tools/mcp/manager.ts`'s
  `expandEnvPlaceholder`.
- MCP `mcpServers` config: each server entry gained an `enabled` field,
  **defaulting to `false`**. A server sitting in the global config is
  visible from every project dcode runs in, so it no longer connects the
  moment it's added — opt in per server. `connectMcpServers` now skips a
  disabled server before any connection attempt (no spawn, no dial) and
  reports it via `McpManager.servers` as `status: 'disabled'`, distinct from
  `'failed'`; `/mcp` shows it as `disabled (set enabled: true to connect)`,
  and `/config`'s line now reads `N configured, M enabled`. **Breaking:** an
  existing `mcpServers` entry with no `enabled` field stops connecting —
  add `"enabled": true` to any server you want to keep running.

## [0.17.0] - 2026-09-14

### Added
- **P6: MCP integration.** dcode connects to MCP servers configured under the
  new `mcpServers` config field and exposes each server's tools to the agent
  loop as ordinary tools — the agent loop, `task` sub-agent filtering, and
  `/tools` all treat them identically to built-in tools. Both transports the
  official `@modelcontextprotocol/sdk` client supports out of the box are
  wired up: `stdio` (spawned locally; `command`/`args`/`env`, the latter
  merged on top of the same ambient-secret-stripped env every other spawn in
  `tools/local/` gets) and `http` (streamable HTTP; `url` + static `headers`
  for e.g. a bearer token — no OAuth flow). A config entry can omit `type`
  and let it infer from whether `command` or `url` is present. Servers are
  connected in parallel at startup (REPL and one-shot alike) and closed on
  exit/SIGINT (decision I, PLAN.md §6); a server that fails to connect or
  list its tools is logged as a warning and skipped rather than blocking
  startup. Tool names are qualified as `mcp__<server>__<tool>` to avoid
  collisions across servers; a result's content parts are flattened to text
  (images/audio/binary resources are described, not dumped), and a
  `CallToolResult` with `isError: true` is thrown so it takes the same
  `ok:false` path as any other tool failure. New `/mcp` REPL command lists
  connected servers and their tool counts; `/config` now reports how many
  servers are configured. See `tools/mcp/manager.ts` and PLAN.md §30.

### Changed
- The global config location now follows the XDG Base Directory spec:
  `$XDG_CONFIG_HOME/dcode/dcode.json` (default `~/.config/dcode/dcode.json`),
  replacing the bespoke `DCODE_CONFIG_HOME`. Note the semantics differ —
  `XDG_CONFIG_HOME` is the base config dir (parent of `dcode/`), not the dcode
  dir itself; a relative value is ignored per the spec. **Breaking:** switch
  `DCODE_CONFIG_HOME` to `XDG_CONFIG_HOME` and account for the extra `dcode/`
  path segment.

### Removed
- The `root` config field. The working directory is now always `process.cwd()`
  (`resolveRoot()` takes no argument); nothing exposed `root` via CLI or env, so
  it was only ever a `dcode.json` key. **Breaking:** a `"root"` key in
  `dcode.json` is now rejected by the strict parse — remove it.
- `verbose` as a persisted config key and the `/verbose` REPL command. The
  `--verbose` CLI flag is unchanged and still enables debug diagnostics and
  per-call tool echoes, but verbose is now CLI-only: it lives on the runtime
  `Config` type, not in `configSchema`, so a `"verbose"` key in `dcode.json` is
  rejected and there is no longer a runtime toggle for it.
- The fixed history item-count cap (`maxHistoryItems` config field and
  `cli/repl.ts`'s `trimHistory`). History is now bounded solely by
  `ContextManager`'s token-budget compaction (prune old tool outputs, then
  summarize into `[summary, ...tail]`), the same mechanism that already ran
  before every request. The item cap measured the wrong axis (item count, not
  tokens — so it often clipped tool-heavy sessions well before the token
  budget) and, unlike compaction, deleted turns *without* summarizing them.
  opencode and Claude Code likewise bound history by tokens, not item count.
  **Breaking:** config is parsed with `.strict()`, so a `"maxHistoryItems"`
  key left in `dcode.json` is now rejected as unknown — remove it.

### Fixed
- `kill_process` threw an unhandled `TypeError: Unknown signal: 9` when sent
  a bare numeric signal string, even though its own schema allows one —
  `ChildProcess.kill()` only accepts a numeric signal as an actual `number`.
- `/help` and the REPL prompt called `styleText` directly instead of through
  `util/color.ts`'s `paintFor`, so both ignored `--no-color`/`config.color`.
- `/key set`/`unset` silently discarded the rest of `dcode.json` (model,
  baseURL, context tuning, the other provider's key) if the file was ever
  corrupted, instead of failing loudly the way `readConfigFile` does for the
  same failure.
- `grep`'s `context` lines were rendered identically to match lines; they now
  use `-` vs `:` (ripgrep's own convention) so they're distinguishable.
- `BRAVE_ENDPOINT` was read from `process.env` at module load, bypassing the
  config precedence (`CLI > env > file`) `BRAVE_API_KEY` already goes
  through; it's now a proper `braveEndpoint` config field.

## [0.16.0] - 2026-09-05

### Added
- Compact tool display for interactive (TTY) sessions: instead of one
  `› tool: ✓ done` line per call, a single line updates in place while tools
  run (`⋯ N tools · <current> · <elapsed>`, event-driven — no spinner/timer)
  and freezes into a bounded summary grouped by tool family
  (`2 search · 13 read · 8.5s`) above the streamed answer, with a blank line
  between. The tally spans the whole query — one summary even across many tool
  turns — and grouping by family keeps the line to a fixed handful of segments
  no matter how many tools ran, so it never wraps the way a name list would.
  Frozen via a new `onBeforeText` hook on `runTurn`, fired just before the
  first visible answer chunk. Piped/non-TTY output and `--verbose` keep the
  per-call lines (a log wants one record per call; only a TTY can rewrite a
  line in place). `ui/tools.ts` gains `TurnTally`/`renderProgressLine`/
  `renderCategorySummary`; no new dependency.
- Assistant output is now rendered as styled markdown in the terminal
  (headings, bold/italic, lists, syntax-highlighted code blocks) instead of
  raw text with literal `**`/`#`/backtick characters — via `marked` +
  `marked-terminal` (the same library OpenAI's own Codex CLI uses). New
  `src/ui/markdown.ts`: `renderMarkdown()` for a complete string, and
  `MarkdownStreamRenderer` for live streaming — it buffers deltas and only
  emits fully-formed lines once their block boundary is unambiguous (a
  blank line for prose, a closing fence for code), so a partial `**` or an
  unclosed code fence is never shown broken mid-stream. This mirrors the
  "newline-gated" pattern Codex CLI's Rust TUI converged on (their own PR:
  *"We wait until we have an entire newline, then format it with markdown
  and stream in to the UI"*), scoped down to prose/list gating plus
  fence-holdback — not their full table-holdback/reference-link handling.
  `runTurn` (`src/agent/run.ts`) is the only integration point; nothing else
  in the agent loop changes (`response.output_text` is still the SDK's own
  aggregated text used for history/return). `marked-terminal` ships no
  TypeScript types and `@types/marked-terminal` on npm is stale/mismatched
  (6.1.1, `marked >=6 <12`), so a small local ambient declaration
  (`src/types/marked-terminal.d.ts`) covers just what dcode calls instead.
  Also worked around a real bug in `marked-terminal@7.3.0` itself: its
  `text` renderer returns the raw, unparsed source string for a block-level
  text token instead of rendering its nested inline tokens — and a *tight*
  list item's content is represented as exactly this kind of token, so any
  `**bold**`/`*italic*`/`` `code` `` inside a list item rendered completely
  literally (confirmed directly against the library's source). Fixed with a
  `marked.use({renderer: {text}})` override in `ui/markdown.ts` — the same
  kind of fix Codex CLI carries as a package patch for other issues in the
  same renderer. A second, related `marked-terminal` bug (upstream issue
  [#376](https://github.com/mikaelbr/marked-terminal/issues/376)) only
  became reachable once list items could carry styling at all: its
  `fixNestedLists()` helper matches indentation boundaries with a `\S`
  (non-whitespace) regex, which also matches the trailing `m` of an ANSI
  reset code (`\x1b[0m`) as if it were real content, inserting a spurious
  blank line between nested list items whenever their text is styled. Not
  overridable via the extension system (`fixNestedLists` is an internal
  helper, not a renderer method), so `renderMarkdown()` strips the
  resulting artifact post-render instead — a line that's non-empty,
  *contains at least one ANSI escape*, and is nothing but whitespace once
  those escapes are removed. The ANSI requirement is load-bearing:
  marked-terminal indents fenced code blocks, so a blank line inside a code
  block arrives as a whitespace-only line with no escapes at all, and a
  whitespace-only test alone silently deleted blank lines out of the model's
  code samples. A genuine blank separator line is always the empty string,
  so this can't collide with intentional spacing either (verified against
  loose lists, multi-paragraph text, and code blocks).
- System prompt now tells the model to write math in Unicode (∑ ∫ √ π α β
  ± × ÷ ≤ ≥ ≈ ∈ ∞, x², a/b for fractions) instead of LaTeX. There's no way
  to typeset LaTeX in a terminal — no graphics protocol dcode can rely on
  cross-platform, and CommonMark (what `marked` parses) has no native math
  syntax to even detect `$...$`/`\frac{}{}` before deciding what to do with
  it — so raw LaTeX just showed up as literal backslashes and dollar signs.
  This is the same workaround the wider terminal-agent ecosystem has
  converged on (e.g. the `claude-math` plugin for Claude Code/Codex CLI);
  Claude Code itself still has this as an open, unresolved issue. Verified
  live: asking for the quadratic formula now renders `x = (-b ± √(b² -
  4ac)) / (2a)` instead of LaTeX commands.

### Fixed
- `--help` is rendered from the same `FLAGS` table `parseCli` parses with,
  rather than a separate hand-written block in `index.ts`. The two had already
  drifted: none of the four short forms (`-m`, `-c`, `-v`, `-h`) appeared
  anywhere the user could see them, though all four have always worked.
- `configSchema`'s nested `context` default was a literal object restating all
  six field defaults. zod hands a `.default()` value back verbatim — it does
  not re-parse it — so those were two independent sources of truth for the
  same values: omitting `context` yielded the literal, while writing
  `"context": {}` yielded the real field defaults, and nothing would have
  flagged a divergence. The default is now derived by parsing `{}` through the
  same schema. (`.default({})` does not work for the identical reason: it
  would be returned as-is, giving an empty object with none of the fields.)
- `/save <file>.md` wrote array-shaped message content into the transcript as
  raw JSON: `historyToMarkdown` reimplemented content extraction as
  `typeof === 'string' ? … : JSON.stringify(…)` instead of using the shared
  `contentToText`, which exists precisely so the two can't diverge.
- `runTool`'s `withDeadline` (`src/agent/run.ts`) now actually races the tool
  promise against `config.toolTimeout` and `ctx.signal` instead of `await`ing
  it and consulting the signals only afterwards. As written, a tool that
  neither observed `ctx.signal` nor bounded itself — a prompt waiting on
  stdin, a stalled socket — held the whole agent loop open forever with
  `toolTimeout` never enforced against it. Now a `Promise.race` against a
  deadline promise driven by `AbortSignal.any([signal, timeout])`. Losing
  that race *abandons* the tool promise rather than cancelling it (nothing
  can force a tool to stop from outside), so a no-op `.catch()` keeps the
  eventual failure from surfacing as an unhandled rejection, the abort
  listener is removed in a `finally` so a fast tool doesn't leave listeners
  piling up on a turn signal that outlives it, and a tool that *does* observe
  the abort has its own low-level error normalized to the same
  `aborted` / `timed out after Nms` text.
- `ask_user` hung forever when stdin isn't a TTY: `@clack/prompts` rendered
  its menu and waited for a keypress that never came, so a piped one-shot run
  (`dcode -p "…" < /dev/null`, CI) deadlocked. It now refuses up front and
  tells the model to proceed on its own judgement.
- `grep` threw `Cannot read properties of undefined (reading 'replace')` and
  failed the entire search whenever any matched file held invalid UTF-8:
  ripgrep's `--json` encodes strings as either `{text}` or, for non-UTF-8
  data, `{bytes}` (base64), and `formatRgLine` assumed `text`. Both forms are
  now decoded (lossily, for `bytes`), and an event carrying neither is
  skipped rather than emitted half-formed.
- Blank lines inside fenced code blocks were deleted from rendered assistant
  output — see the `stripSpuriousAnsiOnlyLines` note under Added.
- Sub-agents shared the session's single `TaskStore`, so a sub-agent calling
  `todowrite` replaced the *parent's* entire todo list — including the
  authoritative task list `compact.ts` injects into compaction summaries.
  `todowrite` is now rebound to a fresh per-sub-agent store.
- The sub-agent tool allow-lists named `list_directory`, but the registered
  tool is `list_dir`, so the name-based filter silently gave every sub-agent
  no directory-listing tool while the `task` tool's description advertised
  it as available.
- The `task` tool accepted `task_id` and `command` parameters and told the
  model that sessions could be resumed and that the result carries a
  `task_id` — none of which was implemented. Both parameters are removed and
  the description now states that every invocation starts from a fresh
  context.
- `runAgent` reconstructed the next turn's input by hand — a synthesized
  assistant-text message plus manually-rebuilt `function_call` items — which
  silently dropped every other item type the model returned, including
  `reasoning` items. OpenAI's docs require reasoning items to be replayed
  alongside their function_call on every stateless (`store: false`) turn that
  continues a tool call, for reasoning models (the GPT-5 family, o-series) —
  which is dcode's default model and default `store` setting against real
  OpenAI. Now uses the SDK's own `toResponseInputItems()` (from
  `openai/lib/responses/ResponseInputItems`) to normalize `response.output`
  into replayable items, which handles this correctly (and simplifies
  `loop.ts`: one `history.push(...)` instead of two separate reconstruction
  blocks). One thing the SDK helper doesn't handle: it doesn't strip
  `parsed_arguments` from `function_call` items, and the real API rejects a
  replayed item carrying it ("Unknown parameter") — confirmed live against
  `gpt-5.4-mini`, since the field isn't in the SDK's own type for that item
  and its normalizer doesn't know to remove it. Stripped explicitly.
- `read_file`'s `offset`/`limit` paging only ever saw the first
  `maxToolOutputBytes` (32 KiB default) of a file; requesting a later page
  silently returned `(no lines in range)`, misreading as end-of-file. Paging
  now reads up to 8 MiB, and an offset genuinely past that window throws a
  clear error instead of a misleading empty result.
- `web_search` now forwards `ctx.signal`, like `web_fetch` already did, so
  Ctrl-C cancels an in-flight search instead of only fetches.
- `web_search`'s Brave key resolution read `process.env.BRAVE_API_KEY` ahead
  of `ctx.config.brave`, even though `buildConfig` already resolves env-over-
  file precedence into `ctx.config.brave` before any tool runs. It now trusts
  `ctx.config.brave` alone, so a key set at runtime via `/key set brave` isn't
  shadowed by a stale environment variable.
- `createClient` decided whether to send `store: false` (opting out of
  OpenAI's 30-day server-side retention) by checking whether `baseURL` was
  configured at all, not whether the endpoint was actually OpenAI. A user
  who explicitly points `baseURL` at `api.openai.com` (e.g. to pin an API
  version) hit neither branch — `store` was omitted entirely, so OpenAI's
  own server-side default (`store: true`) applied unintentionally, silently
  contradicting the documented "off by default" behavior. Replaced the
  `!config.baseURL` check with `isRealOpenAI(config.baseURL)`, which treats
  an unset baseURL *or* one whose hostname is `api.openai.com` as real
  OpenAI (sending `store: false`); any other custom/local endpoint still
  omits the param entirely unless `stateful` is explicitly enabled.
- `setGlobalKey`/`unsetGlobalKey` (`cli/keys.ts`) passed `{ mode: 0o600 }` to
  `writeFileSync`, but that option only applies when the file is newly
  created — a pre-existing `dcode.json` left with looser permissions (an
  editor, or an earlier permissive write) kept its old mode on every
  subsequent key write, silently undermining the "keys are 0600" story. Now
  `chmodSync(p, 0o600)` runs explicitly after every write, regardless of
  whether the file already existed.
- `ContextManager`'s compaction-failure counter (the one backing the 3-strike
  circuit breaker) incremented on every call to the shared private `compact`,
  including a manual `/compact` and a no-op auto-compaction. Three manual
  `/compact` invocations, or three proactive compactions that each found
  nothing to summarize (the whole history already fit within `keepTokens`),
  could silently trip the breaker and disable automatic context management
  for the rest of the session — for reasons unrelated to any real overflow —
  while `beforeTurn` still logged a false `context: compacted`. Fixed in two
  parts: `manual()` no longer touches the counter at all (a user-initiated
  `/compact` was never a failure signal), and `compactHistory` now returns
  `null` instead of `history` unchanged when there's nothing to summarize, so
  `beforeTurn`/`onOverflow` can tell a genuine no-op from a real compaction
  and skip both the counter and the `'compacted'` action/retry signal for it.

- `run_process`'s tool description claimed "the process is killed when the
  session is cancelled," but the spawned child was wired to the *launching
  turn's* `ctx.signal` — and the REPL creates a fresh `AbortController` per
  line, discarding the old one once a turn completes. So a background
  process only died from Ctrl-C if it landed during the exact turn that
  started it (a narrow race, since `run_process` returns almost instantly);
  any later Ctrl-C aborted an unrelated, newer controller and did nothing to
  it. In practice this meant background processes accumulated for the rest
  of the session with no way to stop them short of `kill_process` or exiting
  dcode entirely — while the tool told the model otherwise. `spawn()` no
  longer takes a signal at all: a background process is meant to outlive the
  turn that launched it (that's the point of `run_process` vs `run_shell`),
  so tying it to any single turn's controller was never the right lifecycle
  — it only stops via `kill_process` or when dcode itself exits, and the
  description now says so accurately.
- `web_fetch` had no restriction on the target host, no real request timeout,
  and no cap on how much of a response it would buffer. Its URL is often not
  something the user typed directly — it can come from `web_search` results
  or a previously-fetched page — so the model could be steered into fetching
  `http://169.254.169.254/...` (cloud metadata) or another internal address,
  and a redirect from an otherwise-safe URL could land on one too. The `ctx.
  signal` passed to `fetch()` only fires on user Ctrl-C; `runTool`'s own
  timeout just abandons the promise without cancelling the underlying socket,
  so a slow/hung response kept running (and could keep buffering into
  memory, unbounded) well after the tool reported "timed out". Fixed all
  three: `web_fetch` now resolves the target host (and every redirect hop,
  followed manually rather than automatically) and rejects loopback/
  RFC1918/link-local/cloud-metadata addresses before connecting; the fetch's
  signal is now `AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.config.
  toolTimeout)])`, so a timeout actually cancels the request; and the
  response body is read as a capped stream (5 MiB) instead of `res.text()`,
  so an oversized response is cut off rather than fully buffered first. The
  host guard is a resolve-then-check, not connection-level pinning — a DNS
  record that changes between the check and the real connection (DNS
  rebinding) could still slip through — documented as an accepted residual
  gap rather than a closed one. **(Superseded later this cycle: the host
  guard was removed — see "web_fetch drops host filtering" under Changed. The
  timeout and bounded-read fixes stay.)**
- `--no-color`/`config.color` didn't actually disable ANSI output on a real
  TTY — it only worked when `NO_COLOR` was set or output was piped, because
  neither markdown rendering nor tool-status rendering ever looked at
  `config.color`. `marked-terminal` (via its own internal `chalk` import) and
  `loop.ts`'s `renderToolResult`/`renderToolOutput` (via `ansis.*` called
  directly) both decide their own color support from TTY/env-var detection —
  a decision made once at module-load time, before `--no-color` is even
  parsed from argv, so there was no way to hand either of them a color flag
  after the fact. `renderMarkdown`/`MarkdownStreamRenderer` now take an
  explicit `color` flag and strip ANSI codes via `ansis.strip()` when it's
  false (wired from `config.color` in `runTurn`); `renderToolResult`/
  `renderToolOutput` now take the same flag and build local paint functions
  (identity when disabled) instead of calling `ansis.*` directly, the same
  pattern `util/log.ts`'s `paintFor` already used and for the same reason —
  a global `ansis.enabled` toggle can't be scoped per-call and would leak
  across call sites. Verified live: `FORCE_COLOR=1 dcode --no-color "..."`
  now produces zero ANSI escape bytes in either the streamed response or
  verbose tool-status output, while the same command without `--no-color`
  still colors normally.
- `trimHistory` (`cli/repl.ts`, the REPL's `maxHistoryItems` safety net —
  independent of `ContextManager`'s token-budget compaction) always cut from
  index 0, with no awareness of what lived there. After an automatic or
  manual compaction, history is `[summary, ...tail]`, and the summary at
  index 0 is the model's only record of everything before it. On a long
  enough session, once the item-count cap was hit *again* after a
  compaction, that cut could silently discard the summary itself — a much
  bigger loss than trimming any other single item, since it erases the only
  trace of the pre-compaction conversation rather than just the oldest slice
  of it. `trimHistory` now always protects item 0 (it's always either the
  session's very first user message or a compaction summary, both `role:
  'user'`, so nothing else could be there) and trims from index 1 onward
  instead, still snapping forward past tool items to avoid orphaning a
  `function_call`/`function_call_output` pair. This keeps up to `max + 1`
  items instead of exactly `max` — an intentional, documented trade-off.
- `validateApiKey` (`cli/auth.ts`) had no request timeout, so a stalled
  network could hang startup indefinitely, and it collapsed every non-401/403
  outcome — including a caught network error or a timeout — into a single
  `true`, which `main()` then relied on to decide whether a freshly prompted
  key was safe to persist. `promptForApiKey`'s own comment claimed "a bad
  paste isn't stored," but that only held for a confirmed 401/403; on a
  network failure, an unverified key was written to the global config
  exactly as if it had been confirmed working. `validateApiKey` now returns
  a three-state `'valid' | 'invalid' | 'unknown'` (only a 2xx is `'valid'`;
  only a 401/403 is `'invalid'`; everything else — network error, timeout,
  or any other status — is `'unknown'`) and bounds the request with
  `AbortSignal.timeout(10_000)`. `main()` still only blocks startup on
  `'invalid'` (unchanged behavior for real/custom endpoints that don't
  expose `/models`), but now logs a warning before persisting a freshly
  prompted key when the check came back `'unknown'`, instead of silently
  treating it as verified.
- Four smaller correctness fixes found in the same review pass:
  - `runExec` (`tools/local/exec.ts`) ran a full `.trim()` on combined
    stdout+stderr, which strips meaningful leading whitespace (e.g. a `git
    diff` context line starting with a single space) or trailing spaces on
    the last line, not just the trailing newline it was meant to clean up.
    Now strips only trailing `\n`s (`replace(/\n+$/, '')`).
  - `runRg` (`tools/local/search.ts`, shared by `grep`/`glob`) threw
    `"ripgrep exited with undefined"` on a `maxBuffer` overflow, timeout, or
    abort, since it only checked `exitCode` and none of those set it to a
    number. Now checks `result.isMaxBuffer`/`isCanceled`/`timedOut` first,
    the same fields `runExec`'s catch branch already checks, via a new
    exported `classifyRgFailure` (unit-tested directly rather than by
    triggering a real maxBuffer/timeout against ripgrep, which would be slow
    and flaky).
  - `pruneHistory` (`agent/context/prune.ts`) looped from index 1, silently
    assuming index 0 could never be a `function_call_output` — true given
    how `history` happens to be constructed today, but not actually checked,
    so it was a latent off-by-one rather than an enforced invariant. Now
    loops from index 0.
  - `pruneHistory`'s `protectTurns` option is named as a count of turns but
    protected the last N individual output *positions* — a turn that made
    several parallel tool calls has several outputs pushed as one
    consecutive block, so only part of the most recent turn could end up
    protected while the rest of that same turn was pruned. Outputs are now
    grouped into contiguous runs (each run is exactly one turn's outputs,
    given how `loop.ts` constructs history) and the last `protectTurns` runs
    are protected as a unit.

### Refactored
- The startup API-key path — prompt on a TTY, validate, warn, persist — moved
  out of `index.ts`'s `main()` (~45 inline lines, unreachable by any test
  short of running the binary) into `cli/auth.ts`'s `ensureApiKey`, beside the
  `validateApiKey` it already wrapped. It returns the fatal message instead of
  calling `process.exit` itself, so the caller owns how the process ends and
  the flow is testable; `index.ts` drops from 165 to 101 lines.
- Abort detection was duplicated in `cli/repl.ts` and `index.ts` — the same
  predicate and the same four-line comment about the SDK's
  `APIUserAbortError` versus `runAgent`'s plain `Error('aborted')`. Both now
  call `util/log.ts`'s `isAbortError(err, signal)`.
- `/key`'s `set` and `unset` branches repeated the same
  parse-provider-then-validate sequence; merged. `unsetGlobalKey` checked
  `existsSync` immediately before `readGlobalRaw` checked it again.
- Tools are now built with `tools/registry.ts`'s `defineTool`, which infers a
  tool's argument type from its zod schema. Previously every tool spelled its
  parameter shape twice — as an explicit `ToolDefinition<{...}>` annotation
  *and* as the schema — with nothing keeping the two in sync; `grep`/`glob`
  carried a third copy inline on `execute`, and the tools that skipped the
  annotation (`task`, `ask_user`) fell back to `P = unknown` and cast
  `args as {...}`, an unchecked cast that cannot fail to compile when the
  schema changes. The schema is now the single source of truth.
- Sub-agent tool sets are a `ToolPolicy` (`{allow}` | `{deny}`) instead of
  literal name lists. `general` was a 19-name list documented as "all tools
  except task" — a claim nothing enforced, and one that would silently
  withhold any newly added tool. It is now `{deny: ['task']}`, true by
  construction. `explore` stays an allow-list deliberately: read-only is its
  guarantee, so it must not acquire a new writing tool just because one
  appeared. `createLocalTools` throws on a policy naming a tool nobody
  registers, and the `task` tool's description and agent-type table are
  generated from the resolved sets rather than hand-maintained beside them —
  that copy is how the description came to advertise a `list_directory` tool
  for something actually called `list_dir`.
- Terminal rendering of tool calls (`renderToolResult`, `renderToolOutput`,
  `colorDiffLine`) moved from `agent/loop.ts` to the new `ui/tools.ts`,
  beside `ui/markdown.ts`. Roughly 60 of `loop.ts`'s 305 lines were
  formatting; it is now orchestration only.
- `paintFor` existed twice, in `agent/loop.ts` and `util/log.ts`, with
  near-identical bodies and near-identical comments. Both now use the new
  `util/color.ts` — the single place `styleText` is applied. Its comment
  records the half missing from both copies: auto-detection is the wrong
  input not only because Node resolves colour support before `--no-color` is
  parsed out of argv, but because the answer describes stdout rather than
  whichever sink the caller is writing to.
- `runCalls` returned `{id, outcome}[]` where `ToolResult` already carries
  `id`; it now returns `ToolResult[]`, and the two "never reached a tool"
  outcomes (aborted, unknown tool) come from one helper instead of two
  five-field object literals.
- `runExec`'s argv and shell-mode parameters were dead generality left behind
  by the removed `git` tool — one caller, always passing `[]` and
  `{shell: true}`. It is now `runShell(command, ctx)`, private to `exec.ts`;
  `safeEnv` is unexported, reached only through `baseExecOptions`.
- Smaller: the `task` tool's `description` argument was accepted and silently
  discarded, so it is echoed on the result wrapper to tie a result to its
  delegation; `statTool`'s `try`/`catch` around `lstat` was unreachable (the
  preceding `stat` on the same path already proved it resolves);
  `readFileTool` had two nested error wrappers and re-`stat`ed the path
  instead of the handle it had already opened.

### Changed
- **`web_fetch` drops host filtering (opencode-style).** The
  resolve-then-check SSRF guard (`assertPublicHost` and the hand-rolled
  private-IPv4/IPv6 classification) is removed: `web_fetch` now reaches
  whatever the URL resolves to — loopback, LAN, and cloud-metadata endpoints
  included. The guard was a partial mitigation (fail-open, and defeated by
  DNS rebinding since global `fetch` re-resolves after the check) sitting in
  front of a process that already hands the model unrestricted `run_shell`,
  so it raised the apparent bar without shrinking the real attack surface;
  containment belongs to a surrounding sandbox, matching how opencode's
  web_fetch works. `fetchSafely` is now a thin timeout/abort wrapper with
  native redirect following (no `checkHost`, no manual redirect loop);
  `http.ts` loses the `node:net`/`node:dns` imports. The trust boundary is
  unchanged and unchanged-by-this: **don't point dcode at untrusted input or
  networks** — the same boundary `run_shell` already defines.
- `web_fetch` gains a `format` parameter (`markdown` default, `text`, `html`).
  `markdown` keeps the existing behavior (HTML→Markdown, pretty-printed JSON);
  `text` and `html` return the body unconverted. The choice also sets the
  request's `Accept` header, so a content-negotiating server can return a
  different representation per format.
- `parseCli` now runs `parseArgs` in strict mode: an unrecognized flag is an
  error. Lenient parsing wasn't merely forgiving, it was destructive —
  `dcode --modle gpt-4 "do a thing"` dropped the flag *and* pulled its value
  into the positionals, silently running the default model against the prompt
  `"gpt-4 do a thing"`. This matches the config file, which already rejected
  unknown keys via `configSchema.strict()`. A prompt beginning with `-` still
  works after `--`.
- Exhausting `maxToolIterations` with tool calls still pending now logs a
  warning naming the setting. The loop previously just returned whatever text
  the final turn produced — for a pure tool-call turn, nothing — so a
  truncated run was indistinguishable from the model having no reply.
- The `task` tool no longer accepts `task_id` or `command`. Both were
  documented as working (resumable sub-agent sessions, a `task_id` in the
  result) and neither was implemented.
- System prompt corrections: it referred to "the todo tool" (renamed
  `todowrite`, and now a whole-list write), and told the model to launch
  sub-agents concurrently — which `task`'s `parallel: false` makes
  impossible, since the loop serializes them.

### Docs
- `AGENTS.md`'s "Configuration sources" section gains the rule behind the two
  strictness changes above (unknown input is rejected at every layer, not
  tolerated), how to add a flag (one `FLAGS` entry, never a separate help
  block), and the zod `.default()` verbatim-return trap. It was also missing
  `BRAVE_API_KEY` from the env-var list, as was `README.md`'s.
- `README.md`'s flag table now shows the short forms and documents the `--`
  escape for a prompt starting with `-`.
- `PLAN.md` §5's module tree, `CLAUDE.md`'s architecture section, and
  `AGENTS.md`'s module-layout notes are synced with the above: the
  `ui/tools.ts` and `util/color.ts` split, `defineTool` as the way to add a
  tool, and `ToolPolicy`. `AGENTS.md` also records two constraints that were
  previously load-bearing but unwritten — the `-g` ordering in
  `search.ts` (`config.ignore` patterns must follow the caller's own, because
  ripgrep resolves competing globs last-match-wins; merging them the other
  way silently re-includes ignored files) and the tool-deadline contract in
  `run.ts` (losing the race abandons rather than cancels, so a tool that
  spawns or connects must take `ctx.signal` itself).
- Historical phase specs in `PLAN.md` (§11.8, §22) that describe the
  renderers as living inline in `agent/loop.ts` keep their original text but
  gain a pointer to where the code moved, rather than being rewritten.
- `AGENTS.md`'s "Security model" section documents the trust boundary: dcode
  grants the model real shell access on the user's machine by design
  (`run_shell`/`run_process`, unrestricted, intentionally), and `web_fetch` is
  no exception — it does no host filtering (the private-address guard it
  briefly carried this cycle was removed; see Changed), leaving containment to
  a surrounding sandbox. Also documents why `grep`/`glob` spawn `rgPath`
  directly instead of going through `exec.ts` (ripgrep's exit-code convention
  doesn't fit a throw-on-nonzero contract), so
  it isn't "fixed" into inconsistency by a future contributor. (`runExec` has
  since become `exec.ts`-private `runShell`; the note is phrased in terms of
  the exit-code contract rather than the helper's name.)
- `config/config.ts`'s `mergeConfigs` gained a one-line comment explaining
  why it doesn't use `.strict()` the way `readConfigFile` does: by the time
  `file`/`env` reach the merge, they've already passed through
  `configSchema.strict()` or are built from known, typed literal env-var
  assignments — there's nothing left to typo that `.strict()` would catch.

### Simplified
- `agent/client.ts`'s `isContextOverflowError` cast `(err as {
  code?: string }).code` inside an `if (err instanceof OpenAI.APIError)`
  branch, even though `APIError` already types `code` — narrowed to
  `err.code` directly.
- `tools/local/search.ts`'s `grep` and `glob` each had an identical loop
  pushing `-g '!pattern'` for every `config.ignore` entry — extracted to a
  shared `pushIgnorePatterns(rgArgs, ignore)`.
- `tools/local/process.ts`'s `ProcessManager.kill` discarded
  `subprocess.kill()`'s own return value (whether the signal was actually
  sent), always reporting `'signaled'` even when nothing was sent — e.g. the
  process exited in the race between the `proc.exited` check and the kill
  call. It now checks the return value and reports a distinct `'failed'`
  status, which `kill_process` surfaces as an error instead of a false
  "sent SIGTERM" success message.
- `cli/commands.ts`'s `buildHelp` took a `CommandRegistry` parameter that
  its one caller always filled with the same module-level `COMMANDS`
  singleton — now closes over it directly instead.

### Duplication
- `agent/context/tokens.ts`'s `itemText` and `agent/context/compact.ts`'s
  `serializeHistory` each independently extracted text from the same
  `ResponseInput` item shapes (a message's `content` — string, or an array
  of `{type, text}`-shaped parts) with no shared code, so they could quietly
  drift on how they read the same data. Worse, `itemText`'s version silently
  returned `''` for any `content` shape that wasn't a string or an array
  (e.g. an unexpected object), undercounting that item's real size in the
  token-budget estimate instead of estimating it roughly. Extracted a shared
  `contentToText` (in `tokens.ts`, imported by `compact.ts`) that both now
  use; its fallback for an unrecognized shape is `JSON.stringify`, not `''`.
  One side effect worth noting: `serializeHistory`'s compaction transcript
  used to dump an array-shaped `content` as raw JSON (type tags, annotations
  and all); it now reads just the joined text, same as the token estimator
  — cleaner input for the summarization model, and verified via a new test
  that the compaction instruction contains the extracted text without a
  stray `"type"` JSON key leaking through.

### Architecture
- `agent/client.ts`'s `store` param is now unconditionally
  `params.store = config.stateful` — no more branching on whether the
  configured endpoint "looks like" OpenAI. The removed branch omitted
  `store` entirely for any non-OpenAI baseURL, on the assumption that
  custom/local endpoints might reject an unrecognized field; that's a guess
  dcode has no way to actually verify, and this project's own testing (a
  real Ollama `/v1/responses` endpoint) showed it accepts an explicit
  `store` field fine. If some stricter endpoint ever does reject it, that's
  now a clear API error instead of a silent guess either way.
- New `tools/local/http.ts`: the redirect-following and timeout/signal
  handling that `web_fetch` had were extracted into a shared
  `fetchSafely`/`readBounded` boundary, and `web_search`'s fetch to the
  Brave API now goes through it too — closing a gap where `web_search` had
  no real timeout at all (only `ctx.signal`, which only fires on user
  Ctrl-C). **(Superseded later this cycle: the host guard this originally
  also carried, opt-in via `{checkHost: true}`, was removed; `fetchSafely`
  no longer filters hosts or follows redirects manually. See Changed.)**
- Two related "unify this into a single mechanism" suggestions from review
  were evaluated and declined, with the reasoning now documented in code
  rather than left as an open question:
  - `cli/repl.ts`'s `trimHistory` stays separate from `agent/context/
    manager.ts`'s `ContextManager` (a hard item-count safety net vs. a
    token-budget-driven compaction policy solve different problems). The
    specific hazard a merge would exist to prevent — a cut splitting a
    required item pair — is now proven excluded by trimHistory's own
    invariants (item 0 always protected; a cut can never separate a
    `reasoning` item from its `function_call`, argued out and pinned down
    with a new regression test) rather than merely assumed safe.
  - `tools/local/process.ts`'s `processManager` stays a module-level
    singleton rather than being constructed per session. dcode is one
    process per invocation, so there's no real-usage scenario where two
    sessions actually share this state; the only place the singleton is
    even visible is the test suite (one file, with its own cleanup).
    Threading an instance through `ToolContext`/`createLocalTools` would
    add real plumbing for a problem that doesn't currently occur.

### Maintainability
- `cli/keys.ts`'s `keyField` cast `PROVIDERS[provider] as 'apiKey' |
  'brave'` was only safe because every caller happened to check
  `isKnownProvider()` first — nothing enforced that. `PROVIDERS` is now
  declared `as const` (not `Record<string, 'apiKey' | 'brave'>`), so `keyof
  typeof PROVIDERS` is the exact `'openai' | 'brave'` union; `keyField` now
  requires that narrowed type instead of a bare `string`, so indexing
  `PROVIDERS` is checked by the compiler. The one remaining cast moved to
  `KEY_PROVIDERS`'s own definition (`Object.keys(PROVIDERS) as (keyof typeof
  PROVIDERS)[]`) — a cast over `Object.keys` of a closed, known-shape
  literal (provably safe, just a TS signature limitation), not over an
  arbitrary caller-supplied string.
- `agent/tasks.ts`'s `TaskStore.create`/`get`/`list`/`update` returned the
  store's own live `Task` objects. A caller mutating one directly (e.g.
  pushing onto its `blockedBy` array) would silently corrupt the store's
  state without going through `update()` — the one place meant to change
  it. All four now return copies (a new `copyTask` helper, also copying
  `blockedBy` so the array itself can't be mutated through a returned
  reference either). No current caller actually did this, so no behavior
  change — closing the footgun before something written later relies on it
  by accident. New regression test covers all four methods.
- `cli/commands.ts`'s `buildHelp` padded every command name to a hardcoded
  `padEnd(8)`; a future command with a name longer than 8 characters would
  silently misalign every other line's description column. Width is now
  derived from the actual longest registered name.
- `ui/markdown.ts`'s `MarkdownStreamRenderer` docstring claimed the
  streaming renderer holds back "a `**` that hasn't been closed yet" the
  same way it holds back an unclosed code fence — but `findSafeBoundary`
  only tracks fence parity explicitly; there's no equivalent inline-marker
  tracking. An unclosed `**` mid-paragraph is held back too, but only as a
  side effect of the enclosing paragraph not having reached its own blank-
  line boundary yet, and CommonMark emphasis spans can't cross a block
  boundary anyway — so once a block is judged complete, its `**` balance is
  already final either way. Reworded to describe the actual mechanism
  instead of implying a second, dedicated one exists.

### Performance
- `agent/context/manager.ts`'s `onOverflow` went straight to compaction — a
  full, paid extra model call — on every context-window overflow, even when
  a free, local prune would have recovered enough space on its own. This
  mattered most right after `beforeTurn` had already compacted the same
  turn proactively (crossing the soft threshold) only for the request to
  still overflow the hard limit: that's a second paid compaction call
  back-to-back, immediately after the first. `onOverflow` now tries
  `pruneHistory` first, same as `beforeTurn` already does, only falling
  back to compaction if pruning didn't change anything. A successful prune
  doesn't count toward the circuit breaker (it's real progress, not a
  failed recovery attempt) — only a compaction attempt does, same as
  before. New test confirms a prunable overflow recovers with zero
  compaction calls.

  Two other performance points from the same review pass were evaluated and
  not changed:
  - `web.ts`'s unbounded `res.text()` was already fixed in an earlier commit
    this session (`readBounded`, a capped stream read).
  - `manager.ts` computing `predict()`/`estimateHistory` a few times per
    turn (proactive check, post-prune re-check, the loop's debug log, and
    `observe()`) is real but not worth caching: `estimateHistory` is a
    cheap linear scan over string lengths — microseconds even repeated
    several times — against a per-turn cost dominated by network latency to
    the model (hundreds of milliseconds to seconds). The one call that's
    genuinely redundant (the loop's debug-log call, recomputing what
    `beforeTurn` already computed one line earlier) could only be removed
    by changing `beforeTurn`'s public return shape, which every existing
    test asserts against directly — not a good trade for a microseconds-
    level saving.
  - `process.ts`'s background-process output buffer (`onData` append +
    slice once over `PROC_MAX_OUTPUT`) is bounded at 64 KiB and was already
    flagged as acceptable at that size in the same review.

### Testing
- `vitest.config.ts` now sets `FORCE_COLOR: '1'` for the whole test run.
  ansis (like chalk) decides its own color support once, at module-load
  time, from `process.env`/TTY detection — always false in this
  non-interactive runner. Without forcing it, every `color:true` code path
  was silently degrading to a no-op identity function that happens to
  produce the same plain text as the real colorizer, so tests asserting
  colored output were passing for the wrong reason (this is exactly what
  surfaced two real test failures once fixed — see below). Setting the env
  var in `vitest.config.ts` (applied before any test file's imports run,
  unlike setting it from within a test — module-load-time decisions can't
  be changed after the fact) makes those code paths actually exercise real
  ANSI generation.
  - Two existing tests broke once color was genuinely active and had to be
    updated to `ansis.strip()` their assertions, matching the convention
    every other colored-output test already follows (`agent/run.test.ts`,
    `cli/repl.test.ts`).
  - `util/log.test.ts`'s `color:true` case previously only asserted the
    *stripped* text, which would pass identically whether or not real ANSI
    was ever emitted. Added a second assertion that the raw output actually
    differs from its stripped form, comparing byte-for-byte against
    `ansis.yellow(...)` applied directly.
- New tests covering behavior that was previously exercised only
  indirectly or not at all:
  - `agent/client.test.ts` expanded beyond the `store` param to cover
    `max_output_tokens` (default and override), `tools`/`instructions`
    passthrough (including omission when absent), abort-signal forwarding,
    and the SDK event stream's delta filtering (`response.output_text.delta`
    only) plus `finalResponse` delegation.
  - `agent/run.test.ts`: a `runTurn` test with a fake `Client` whose
    `finalResponse()` throws unless the async delta iterator was fully
    drained first — pins down that `runTurn` honors the SDK's documented
    "drain the stream before requesting the final response" contract,
    since that can't be verified against the real SDK without a live call.
  - `config/schema.test.ts` (new file): the `context.keepTokens < window -
    reserved` `.refine()` (the guard that keeps compaction able to make
    progress at all) and `.strict()` rejecting an unknown key, both at the
    top level and nested inside `context` — the exact validation that
    prevents a typo'd config from silently doing the wrong thing at
    runtime.
  - `agent/loop.test.ts`: an end-to-end `runAgent` test with `color:false`,
    a tool call, and verbose tool-output echoing, asserting zero ANSI
    escape bytes anywhere in what was written — the actual bug scenario
    from the `--no-color` fix, run through the real code path rather than
    only unit-testing the pieces in isolation.
  - `agent/context/manager.test.ts`: `isContextOverflowError`'s three
    branches (413 status, `error.code`, message regex) are now each
    covered independently, plus a negative case that matches none of them.
  - `tools/index.test.ts` (new file): a `createLocalTools` smoke test
    asserting the exact expected set of registered tool names with no
    duplicates — would catch a renamed/missing export or an accidental name
    collision silently overwriting an earlier registration, neither of
    which `pnpm typecheck` alone catches.
- Two weak tests fixed:
  - `cli/auth.test.ts`'s `baseConfig` was a hand-rolled object cast `as
    Config` with a stale shape (`context: {enabled, maxChars, mode}`,
    `tools: {write, edit, shell}` — neither matches the real schema, which
    has no `tools` field at all). Rebuilt from the real `configSchema` via
    the shared `cfg` helper, so the fixture can't silently drift from what
    `validateApiKey` actually receives at runtime.
  - `util/log.test.ts`'s color assertion weakness — see above.

### UI/UX
- A single idle Ctrl-C (no turn in flight) used to be a completely silent
  no-op — no feedback, no exit — which reads as "the terminal is frozen"
  rather than "nothing to interrupt right now." The REPL now follows the
  bash/Python/Node-`repl`-module convention: the first idle Ctrl-C shows a
  hint (`(To exit, press Ctrl-C again or type /exit)`), a second one within
  2 seconds exits. Ctrl-C during an in-flight turn still just aborts it, as
  before.
- Tab completion on an empty token (right after a trailing space, or on a
  blank line) used to return no completions at all, even though this is
  exactly when browsing the current directory would be most useful — a
  leftover early-return that skipped straight past logic that already
  handles an empty `base` correctly (every filename starts with `''`).
  Removed the early return; Tab on an empty token now lists the current
  directory, matching normal shell completion behavior.
- `/reset` cleared the entire conversation immediately, with zero
  confirmation and no way back (unlike `/undo`, which only drops the last
  exchange). It now requires `/reset confirm`; a bare `/reset` explains
  what it would do and suggests `/save` first — the same non-interactive
  "refuse and explain" pattern `/save`'s own overwrite guard already uses,
  rather than a silent one-shot destructive command. `/undo` is left
  unguarded: its blast radius is already bounded to one exchange, and it's
  the *recovery* command — requiring confirmation to use the undo tool
  would be backwards.
- `/compact` runs a real model call with no incremental output (unlike a
  normal streamed turn); a slow endpoint or large history could leave the
  terminal looking frozen until the whole summary comes back with no
  indication anything was happening. It now prints `compacting…` first.
- `/key` always writes to the global config (`~/.config/dcode/dcode.json`),
  never to whatever `--config <path>` a session was launched with — that
  flag only changes where config is *read* from at startup. The command's
  own output already named the actual file it wrote, but this wasn't
  documented anywhere a user would find it before being surprised. Added an
  explicit note to both `README.md` and `AGENTS.md`.
- `--no-color` broken on a real TTY was already fixed in an earlier commit
  this session (`5b3b9bc`) — the highest-value item from the same review
  pass.

### Dead Code
- `tools/local/paths.ts`'s `fsError` was exported but never imported
  anywhere outside the module itself (only `withFsError`, in the same file,
  calls it) — dropped from the export list.
- `cli/commands.ts`'s `createCommands()`/`COMMANDS` split (the factory is
  exported for test-only isolated registries; production always resolves
  against the one module-level `COMMANDS` singleton via `dispatch`) is kept
  as-is, not consolidated — it's intentional, not an oversight: there's
  currently no notion of a per-session command set to inject, so there's
  nothing for `dispatch` to take a registry parameter for yet. Documented
  with a comment instead of restructured, since introducing that parameter
  now would be unused surface area for a feature nothing asks for.
- `agent/context/tokens.ts`'s `estimateTokens` stays exported, despite being
  used internally only by `estimateItem` today: it has its own direct,
  boundary-focused unit tests (empty string, exactly-4-chars, exactly-5-
  chars) that only work with it exported, and un-exporting it would just
  move that same coverage behind `estimateItem`/`estimateHistory` — losing
  directness for no reduction in actual surface area, since the function
  isn't going anywhere either way.

### Changed
- `grep` and `glob` are now both backed by ripgrep (via `@vscode/ripgrep`, a
  bundled platform binary — no separate install required) instead of a
  hand-rolled `walkDir` + JS-regex/glob scan, which is now deleted
  (`traverse.ts`). `grep`: ripgrep is 5–13x faster, streams files instead of
  loading them whole (`--max-filesize 5M` skips oversized files, silently —
  ripgrep doesn't report these skips anywhere), and its regex engine is
  guaranteed linear-time, so a pathological pattern can no longer hang the
  process the way a backtracking JS regex could; patterns are now Rust regex
  syntax (no lookaround/backreferences). `glob`: patterns are now
  gitignore-style globs via `rg --files -g` — a bare pattern like `*.ts` (no
  `/`) now matches at any depth rather than only the top level, matching how
  `.gitignore` itself works. `ctx.config.ignore` patterns map onto `-g
  '!pattern'` for both tools. Both tools now depend on a native binary rather
  than being pure JS — `git` was already this kind of dependency, so it's not
  a new category of risk. (One sharp edge worth documenting: ripgrep matches
  an anchored `-g` pattern like `sub/**` relative to `cwd`, not to the
  search-target argument — both tools pass `.` as the target with `cwd:
  ctx.root` already set, rather than an absolute path, specifically to avoid
  that trap.)
- `run_process`/`kill_process` now spawn via `execa` (`killDescendants: true`)
  instead of hand-rolled `child_process.spawn` + `process.kill(-pid, sig)`
  process-group bookkeeping — the same mechanism `run_shell`/`git` already use.
  The in-memory process-record map is also now capped (evicting the oldest
  already-exited entries), so a long session calling `run_process` repeatedly
  no longer grows it without bound.
- Removed the hand-rolled `StreamRef`/`ModelStream.abort()` turn-cancellation
  plumbing (threaded through `client.ts`, `run.ts`, `loop.ts`, `repl.ts`, and
  `index.ts`). `client.responses.stream()` accepts a native `signal` in its
  request options, which the SDK's own `EventStream` already wires into its
  internal `AbortController` — the same `AbortSignal` the REPL/one-shot path
  already creates per turn (and passes to tools as `ctx.signal`) is now passed
  straight through instead of a second, redundant cancellation path. Verified
  live: aborting mid-request now surfaces `OpenAI.APIUserAbortError` in
  ~300ms. Abort detection in `repl.ts`/`index.ts` now checks for that error
  type directly (alongside the existing `signal.aborted` check, which still
  covers the loop's own `Error('aborted')` thrown between tool calls) instead
  of relying solely on the signal flag.

### Internal
- `fs.ts`: extracted `withFsError`/`ensureParentDir` helpers (`paths.ts`) to
  replace the try/catch-then-`fsError`-wrap idiom that every tool in the file
  hand-rolled, and the identical `mkdir(dirname(dst)).catch(...)` block
  duplicated across `write_file`/`move_file`/`copy_file`. No behavior change.
- Extracted `baseExecOptions(cwd, signal)` (`exec.ts`) — `cwd`/`env`/
  `extendEnv`/`cancelSignal` had been set up identically in three places
  (`runExec`, `search.ts`'s `runRg`, and `process.ts`'s `ProcessManager.spawn`)
  once `grep`/`glob` moved to ripgrep gave it a third occurrence. No behavior
  change.
- `run_shell`/`git` now run subprocesses via `execa` instead of raw
  `child_process.execFile`, replacing the hand-rolled timeout/signal/
  maxBuffer error normalization with execa's structured error fields
  (`timedOut`, `isCanceled`, `isMaxBuffer`, `exitCode`). `killDescendants: true`
  is required to keep shell-mode timeout/abort prompt — otherwise the shell
  doesn't forward the kill signal to a running foreground child until it
  finishes on its own.
- Refactored REPL slash commands into a `CommandRegistry` (`src/cli/registry.ts`),
  mirroring the tool registry: each command is a self-describing definition
  (name, description, aliases, handler). `/help` and tab-completion now derive
  from one source, removing the separate `COMMAND_DESCRIPTIONS` map. No behavior
  change beyond `/help` listing aliases inline (`tasks (alias: /todo)`).

## [0.15.2] - 2026-08-28

### Fixed
- The agent loop stored the raw SDK `function_call` object (which carries a
  `parsed_arguments` server field) in `history`; replaying it as `input` on the
  next turn caused `400 Unknown parameter: 'input[n].parsed_arguments'`. Tool-call
  items are now stored with only the canonical input shape (`type`/`call_id`/
  `name`/`arguments`).

## [0.15.1] - 2026-08-28

### Fixed
- `/key set`/`unset` and `/model` now rebuild the client so the change takes
  effect for subsequent requests (the OpenAI client captured the key/model at
  construction, making earlier in-session changes no-ops).
- A failing REPL command (e.g. `/save` to a missing directory, `/compact`
  erroring) no longer crashes the REPL — the dispatch error is logged and the
  session continues.
- `/save` creates parent directories for nested paths instead of erroring.
- Command names are case-insensitive (`/Help`, `/MODEL` work); `/key` provider
  names too. Args (keys, paths, model ids) keep their original case.

## [0.15.0] - 2026-08-28

### Added
- Parallel read-only tool execution. `ToolDefinition` gains an optional
  `parallel?: boolean` (default `true`); the agent loop batches consecutive
  read-only calls via `Promise.all` while running mutating calls
  (`parallel: false`) sequentially in emission order. Restores the parallel-reads
  behavior lost when the P5 gate/parallel split was removed, but as pure
  scheduling with no permission prompt.
- `/save [path]` REPL command: writes the conversation `history` to a file.
  A `.md` path renders a Markdown transcript; otherwise it writes verbatim JSON
  for reload. Refuses to overwrite an existing file.
- `/limit <n>` REPL command: sets `maxToolIterations` at runtime.

### Docs
- `README.md` and `PLAN.md` refreshed: full tool table (file lifecycle +
  background-process tools), `/key` in the command lists, phase table extended
  through P13, key-resolution prose no longer references the removed local
  config, and the example model set to `gpt-5.4-mini`.

## [0.14.1] - 2026-08-28

### Fixed
- `/help` now lists commands in alphabetical order. Entries are defined in a
  `COMMAND_DESCRIPTIONS` map and rendered sorted, instead of a hardcoded,
  unsorted list.

## [0.14.0] - 2026-08-28

### Fixed
- `baseURL` normalization now ensures the `/v1` API-version prefix is present
  (appended when missing) instead of stripping it. The OpenAI SDK appends the
  resource path (`/responses`, `/models`) to `baseURL`, so the prefix must be
  part of the value; stripping it produced a `…/responses` path that 404'd on
  OpenAI-compatible endpoints such as Ollama. Both `http://localhost:11434` and
  `http://localhost:11434/v1` now resolve correctly, and `validateApiKey` probes
  the real `/v1/models` endpoint (so the default key is actually authenticated).

## [0.13.11] - 2026-08-28

### Fixed
- First-run key bootstrap now validates the prompted key before persisting it, so
  a typo'd key can't get stuck in the global config.
- The `context` config block is now `.strict()`, so typos inside it (e.g.
  `windw`) are rejected instead of silently ignored.
- `readConfigFile` no longer re-checks file existence (already guarded by
  `loadConfig`) and reports JSON parse errors with their own message.

## [0.13.10] - 2026-08-28

### Added
- First-run key bootstrap: in REPL mode, when no API key is configured, dcode
  prompts once and persists it to the global store via `/key`. One-shot mode
  still hard-fails with setup guidance.

### Changed
- Dropped repo-local `./dcode.json` / `.dcode.json` auto-discovery. Config now
  resolves as `CLI > env (process) > global ~/.config/dcode/dcode.json > schema
  defaults`; an explicit `--config <path>` replaces the global file (a missing
  path is an error). dcode is a globally installed personal tool, so there is no
  repo-local config.
- Default model changed from `gpt-5` to `gpt-5.4-mini`.

### Fixed
- Default base URL is now `https://api.openai.com/` (the OpenAI SDK appends
  `/v1` itself; the previous `…/v1` produced a doubled `/v1/v1/…` path). The
  `validateApiKey` probe now hits `/v1/models`, so the default endpoint is
  actually authenticated.

## [0.13.9] - 2026-08-27

### Changed
- Config cleanup:
  - Documented the explicit resolution precedence `CLI > env (process) > local
    ./dcode.json > global ~/.config/dcode/dcode.json > schema defaults` in code
    comments and AGENTS.md/README.md/CLAUDE.md, and added an integration test
    locking the full chain.
  - Dropped automatic `.env` file loading: removed `--env-file-if-exists=.env`
    from the `src/index.ts` shebang and the `dev`/`start`/`stress` scripts. Config
    files (local + global via `/key`) now cover project-local and global needs;
    `process.env` is still read for shell-exported vars. The missing-key /
    invalid-key guidance no longer references `.env`.
  - `tests/index.test.ts` now isolates `DCODE_CONFIG_HOME` so a real global config
    doesn't break the "no key configured" case.

## [0.13.8] - 2026-08-27

### Added
- GAIA benchmark harness (`scripts/gaia/`, new; standalone from the agent).
  `run_gaia.py` loads the GAIA validation split, runs dcode per task (cwd =
  a per-task dir holding the attachment), extracts the `FINAL ANSWER:` line,
  and scores with a faithful port of GAIA's `question_scorer` (numeric equality,
  comma/semicolon list equality, normalized string equality, and the `"3,676"`
  two-element-list quirk). Run artifacts stay in a temp dir; the repo only
  carries the harness + `requirements.txt`.

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
