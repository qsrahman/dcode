# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dcode` — a CLI-based AI coding agent built on the OpenAI Responses SDK. Runs
locally via Node's type stripping (no build step). Phases P0–P11 and P6 are
complete (one-shot, REPL, tool-using agent loop, read-only + mutating local
tools, in-session todo list, context-window management, global key storage,
MCP integration), plus three additions outside the numbered phases: streamed
markdown rendering, `ask_user`, and sub-agents (the `task` tool). P5
(declarative permissions) was cancelled and its gate/approval machinery
removed — all tool calls run unconditionally, MCP tools included. P9's scoped
`git` tool was implemented and then removed (it added no safety over the
ungated `run_shell`); git is reached via `run_shell`. P12 (symbol search) and
P13 (apply_patch) are planned. See PLAN.md §8.

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
  `createLogger(config)` (`debug`/`info` gated by `config.verbose`, `warn`/`error`
  always emit).

## Architecture

`agent/turn.ts` (`runTurn`) and `agent/exec.ts` (`runTool`, `runCalls`) hold
the low-level per-turn/per-tool primitives: `runTurn`
streams deltas from the OpenAI Responses client through a
`MarkdownStreamRenderer` (`ui/markdown.ts`) to a `sink` for live, styled
rendering — the renderer buffers deltas and only emits fully-formed lines
once their block boundary is safe (a blank line for prose, a closing fence
for code), so partial markdown syntax is never shown broken mid-stream —
then returns the SDK's own aggregated text (`Response.output_text` from
`stream.finalResponse()`) plus the full response (so callers can inspect
tool calls) — it does not reconstruct text from the deltas itself; only what's
*displayed* goes through the renderer. `runTool`
executes a single tool call with output truncation and a real
`Promise.race` deadline (`withDeadline`) against `config.toolTimeout` and
`ctx.signal` — losing that race *abandons* the tool promise rather than
cancelling it (nothing can force a tool to stop), which is why spawning and
network tools also take `ctx.signal` directly, and why a tool that blocks on
input refuses up front instead (`ask_user`'s TTY check). Turn
cancellation is native, not hand-rolled: `runTurn` passes `opts.signal`
straight into `client.stream()`'s request options, which the SDK's own
`EventStream` wires into its internal `AbortController` — there is no
separate `StreamRef`/`abort()` handle to track (removed; aborting `ctx.signal`
now cancels the in-flight HTTP request directly, surfacing as
`OpenAI.APIUserAbortError`).
`agent/loop.ts` owns orchestration on top of those: `runAgent` drives the
tool-calling loop (stream a turn, execute the model's tool calls — read-only
calls are batched in parallel via `Promise.all`, mutating calls run
sequentially in emission order — feed `function_call_output`s back, repeat up
to `maxToolIterations`). Each turn's `response.output` is replayed into
`history` via the SDK's own `toResponseInputItems()` (`openai/lib/responses/
ResponseInputItems`), not a hand-reconstructed `{role, content}` pair —
this preserves `reasoning` items, which reasoning models (the default
`gpt-5.4-mini`, GPT-5 family) require replayed on every stateless turn
(`store: false`) that continues a tool call. One SDK gap it doesn't cover:
`function_call` items carry a `parsed_arguments` field the live API rejects
on replay ("Unknown parameter"), so `loop.ts`'s `stripParsedArguments` strips
it explicitly after normalization.
The loop is orchestration only: all terminal rendering of tool progress is
owned by `ui/tools.ts`'s `createToolProgress(sink, config)` — a small reporter
(`onResult`/`renderBatch`/`separate`/`freeze`) that hides the two rendering
modes so `runAgent` never branches on them inline. It sits beside
`ui/markdown.ts`, and both get their colorizers from `util/color.ts`'s
`paintFor(color)` — the single place `styleText` is applied, shared with
`util/log.ts`. The two modes, gated on `process.stdout.isTTY` (and not CI,
not `--verbose`): an interactive TTY gets a *single per-query* summary — one
live line that updates in place on each tool completion
(`⋯ N tools · <current> · <elapsed>`, event-driven, no timer) and freezes
once into a bounded category summary (`renderCategorySummary`:
`2 search · 13 read · 8.5s`, counts by tool family so its width never grows
with the call count) above the streamed answer. The tally
(`ui/tools.ts`'s `TurnTally`) spans the whole `runAgent` call, accumulating
across every tool turn, and is frozen by the reporter's `freeze()` — fired via
`runTurn`'s `onBeforeText` hook just before the first visible answer chunk
(reliable because intermediate reasoning turns emit no visible text), with an
end-of-loop and abort-path freeze for a query that ends on tools with no
closing text. Piped/non-TTY/CI output and `--verbose` instead keep the stable
one-line-per-call form (`renderToolResult`/`renderToolOutput`) — a log wants
one record per call, and only a TTY can rewrite a line in place. The turn
itself is run through `completeTurn`, which quarantines the two provider-side
recovery paths (compact-and-retry on a context overflow via
`recoverFromOverflow`; inject `Continue.` and retry on a `max_output_tokens`
truncation) so the main loop reads as a linear sequence. `paintFor` takes an explicit flag rather than letting Node
auto-detect, for two reasons: colour support is resolved at startup, before
`--no-color` is parsed out of argv, and the answer describes stdout rather
than whichever sink the caller writes to. Exhausting `maxToolIterations`
with tool calls still pending logs a warning naming the setting, since the
loop would otherwise return the last turn's text — nothing at all, for a
pure tool-call turn.
`runOneShot` is a thin wrapper that builds `[system, user]` and delegates to
`runAgent`. Tools live under `tools/`: `tools/registry.ts`'s `ToolRegistry` (built once
per session; `toResponsesTools()` is memoized) registers `ToolDefinition<P>` objects — a
generic with zod-typed params and a type-safe `execute(args: P, ctx)`;
it is named `ToolDefinition` rather than `Tool` to avoid colliding with the
SDK's own `Tool` type, which every import site aliases as `ResponsesTool` — and
converts them to Responses JSON Schema via `z.toJSONSchema`. Tools are built
through `registry.ts`'s `defineTool`, which *infers* the argument type from
the zod schema; don't hand-write a `ToolDefinition<{...}>` annotation beside
the schema (the two drift, and the tools that skipped the annotation ended up
casting `args as {...}`, which no longer type-checks against a schema change). `tools/local/`
implements the full local tool set, split by concern, over shared
`paths.ts` (`resolvePath`, `fsError` — path confinement, realpath-checked
against symlink escapes; `withFsError`/`ensureParentDir` — the fs.ts tools'
shared error-wrapping and mkdir-parent idioms) module: `fs.ts` (`read_file`,
`list_dir`, `stat`, `write_file`, `edit_file`, `move_file`, `copy_file`,
`delete_file`, `make_dir`), `search.ts` (`grep`, `glob`), `exec.ts`
(`run_shell`), `process.ts` (`run_process`, `read_process`,
`kill_process`), `todo.ts` (`todowrite`), `question.ts` (`ask_user`),
`task.ts` (`task`), `web.ts` (`web_search`, `web_fetch`) over `http.ts`'s
shared `fetchSafely`/`readBounded` network boundary.
`exec.ts`/`process.ts`/`search.ts` all spawn through `exec.ts`'s
shared `baseExecOptions`/`safeEnv` (`cwd`/`env`/`extendEnv`/`cancelSignal`,
common to every spawn in `tools/local/`) plus a local `runShell` on top for
`run_shell` specifically, which wraps `execa` (`killDescendants: true`
so a killed shell/process's own children die with it; env is rebuilt via
`safeEnv()` rather than inherited, so secret-looking vars like
`OPENAI_API_KEY` never reach a child process). `grep` and `glob` (both in
`search.ts`) instead spawn
`rgPath` from `@vscode/ripgrep` directly, not through `exec.ts` — ripgrep's
exit code 1 means "ran fine, nothing found", which doesn't fit a
throw-on-nonzero contract, so both share a local `runRg` helper with the
right exit-code handling. Their `-g` argument order is load-bearing:
`config.ignore` patterns must be appended *after* the caller's own patterns,
because ripgrep resolves competing globs last-match-wins and a request for
`**/*` would otherwise re-include everything they excluded. `grep` parses ripgrep's `--json` event stream — whose
strings come back as either `{text}` or, for data that isn't valid UTF-8,
`{bytes}` (base64), so `rgText` decodes both rather than assuming `text`;
`glob` parses its plain `--files -g <pattern>` output. Both pass `.` (not an
absolute path) as the search target with `cwd: ctx.root` already set —
ripgrep matches anchored `-g` globs relative to cwd, so an absolute target
argument silently breaks patterns like `sub/**`. `grep`/`glob` are the
tools with a native-binary dependency (the old pure-JS `traverse.ts`
`walkDir`/`globToRegExp`/`createIgnore` implementation was deleted once both
tools moved to ripgrep). `web_search`'s Brave
key comes from `ctx.config.brave` only — `buildConfig` already resolves
`BRAVE_API_KEY` (env) over the stored config file into it before any tool
runs, so the tool itself doesn't re-read `process.env`.
`createLocalTools(tasks, client, mcpTools?)` is the single hub that registers
all built-in tools (plus whatever MCP tools the caller already connected —
see below) into the `ToolRegistry` and is used by both `runOneShot` and the
REPL; it takes the session's `Client` because the `task` tool reuses it for
sub-agents, and registers `task` last (after MCP tools) so it can both close
over the finished registry by reference *and* have its own generated
description (`describeAgentTypes`) reflect the full tool set, MCP tools
included, rather than a snapshot frozen before they were added.

MCP integration (P6): `tools/mcp/manager.ts`'s `connectMcpServers(config.
mcpServers, logger)` connects every configured server (stdio, spawned via the
official `@modelcontextprotocol/sdk` client; or streamable HTTP with static
headers — no OAuth) in parallel at startup, wraps each server's tools as
ordinary `ToolDefinition`s named `mcp__<server>__<tool>`, and is called
before `createLocalTools` in both `index.ts` (one-shot) and `cli/repl.ts`'s
`createSession` (REPL) — decision I (PLAN.md §6): session-lived, closed on
exit/SIGINT via `McpManager.close()`. A server that fails to connect or list
its tools is logged as a warning and skipped, the same degrade-gracefully
posture `web_search` has for a missing Brave key, so one bad server config
can't block startup. `ToolDefinition` gained an optional `jsonSchema` field
for this: an MCP tool's input schema is already JSON Schema from the server,
so `toResponsesTool` uses it verbatim instead of round-tripping through a
hand-built zod schema (`parameters` on an MCP tool is just a permissive
passthrough for runtime parsing — the server, not dcode, is authoritative on
argument shape). See PLAN.md §11's P6 entry.

Sub-agents: `agent/subagent.ts` defines the agent types (`general`,
`explore`) as a tool-name allow-list plus a system prompt, and
`tools/local/task.ts`'s `task` tool runs a nested `runAgent` with a
`ToolRegistry` filtered to that policy, a silent sink (only the final text is
returned to the parent), compaction disabled, and `ctx.depth + 1` — `MAX_DEPTH
= 1`, so sub-agents can't spawn sub-agents. A type's tools are a `ToolPolicy`,
not a literal list: `explore` uses `{allow: [...]}` because read-only is a
guarantee it must keep even when new tools appear, `general` uses
`{deny: ['task']}` so "everything except task" holds by construction rather
than as a copy of the registry that rots. Policy names are matched against
real registered tool names, so a typo silently does nothing —
`createLocalTools` therefore throws on any policy name nobody registers, and
the tool's description is generated from the resolved sets rather than
hand-written beside them (that copy is how it came to advertise a
`list_directory` tool that doesn't exist). `todowrite` is the one tool *not* passed through by reference:
it's rebound to a fresh per-sub-agent `TaskStore`, since `TaskStore.replace`
overwrites the whole list and would otherwise wipe the parent's plan (which
`compact.ts` injects into compaction summaries as the authoritative task
list). Sub-agent sessions are never resumable — every call starts from a
fresh history.

The REPL (`cli/repl.ts` + `cli/commands.ts`) reuses `runAgent` directly,
keeping a module-local `Session` (`{ config, client, logger, history, tools,
mcp }`) and dispatching slash commands (`parseCommand`/`dispatch` in
`commands.ts`) before falling through to a model turn. `createSession` is
`async` (connecting MCP servers is), and `startRepl` wraps the REPL loop in
`try { … } finally { await session.mcp.close() }` so every exit path closes
connected servers.

`index.ts` wires CLI args -> config -> `ensureApiKey` -> either `runOneShot`
(prompt given, with its own `ToolRegistry`) or `startRepl` (no prompt, builds
its own `ToolRegistry` inside `createSession`). `ensureApiKey` (`cli/auth.ts`)
owns the whole startup key path — prompt on a TTY when none is configured,
check it, persist a freshly pasted one — and returns the fatal message rather
than calling `process.exit` itself, so the caller owns how the process ends
and the flow stays testable. `cli/args.ts` holds one `FLAGS` table feeding
both the `parseArgs` options and `formatFlags()`, which renders `--help`;
parsing is strict, so an unknown flag is an error rather than being silently
folded into the prompt positionals.

Config resolution precedence is **CLI > env > global (`~/.config/dcode/dcode.json`) > schema defaults**,
implemented in `buildConfig` in `config/config.ts` (which layers file, env, and
args in one place) with `config/schema.ts` (zod) as the source of truth for
shape and defaults. The working-directory root is always `process.cwd()` (there
is no configurable `root`), read directly where the system prompt and tool
context need it. `verbose` is a CLI-only runtime flag (`--verbose`), not a
persisted config key: it lives on the runtime `Config` type but not in
`configSchema`, so `buildConfig` attaches it from argv while the strict file
parse rejects a `"verbose"` key in `dcode.json`. `readConfigFile` (which
`buildConfig` calls, and which absorbed the old `loadConfig` path resolution)
parses the config file with
`configSchema.strict()` (not `.partial()` — every field already tolerates
absence via `.optional()`/`.default()`), so a typo'd key in `dcode.json` fails
loudly instead of being silently ignored; the nested `context` object is
`.strict()` too, since `.strict()` doesn't cascade into nested objects on its
own. A missing default config (`dcode.json`/`.dcode.json`) falls back to
schema defaults (`{}`), but an explicit `--config <path>` that doesn't exist
throws rather than being silently ignored. The nested `context` default is
derived (`contextSchema.default(() => contextSchema.parse({}))`) rather than
written out as a literal: zod returns a `.default()` value verbatim without
re-parsing it, so a literal would be a second copy of the field defaults that
could diverge from them silently.

See PLAN.md §5 for the full module tree, §10 for planned/candidate work, and
§11 for a compact history of each completed phase.

## Testing

Tests live in `tests/`, mirroring `src/` (`tests/cli/args.test.ts` ->
`src/cli/args.ts`). Mock external boundaries (OpenAI client, `child_process`,
`fs`); assert colored output against `node:util`'s
`stripVTControlCharacters(...)`. `tests/helpers.ts` holds shared fakes (e.g. a
fake streaming client) used across suites. `pnpm stress`
(`scripts/live-stress.ts`) is the live end-to-end counterpart: it talks to the
real model over this repository and is never part of `pnpm test`.
