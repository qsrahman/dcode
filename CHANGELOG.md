# Changelog

All notable changes to **dcode** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Tools: `stat` (type/size/mtime of a file or directory) and `glob`
  (recursive `**`-pattern file matching, hand-rolled glob→RegExp, no new
  dependency) join `read_file`/`list_dir`/`grep` in `tools/local/fs.ts`.
- `--verbose` now also echoes each tool call's raw output to the terminal
  (previously only the `› name: ✓ done (Ns)` status line was shown).

### Changed
- `tools/registry.ts#toResponsesTool` now converts zod schemas to JSON Schema
  via zod v4's built-in `z.toJSONSchema`, replacing the hand-rolled converter
  originally specified for P3 (PLAN.md §11.12).
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

### Fixed
- `grep` now returns paths relative to the working directory root, matching
  `list_dir`/`glob` and the system prompt's own "pass paths relative to its
  root" instruction — it previously leaked absolute host filesystem paths.
- `grep`'s directory walk no longer follows symlinks (avoiding infinite
  loops) and no longer crashes on unreadable/binary files; `tools/index.ts`
  falls back gracefully if zod schema conversion fails for a tool.
- `agent/system.ts`'s base system prompt now names the read-only tools that
  actually exist, instead of a stale, pre-P3 description.
- `runTool` now validates model-supplied tool-call arguments against the
  tool's zod schema before executing and returns a model-readable error
  instead of throwing raw exceptions on malformed args.
- `config/config.ts#loadConfig` now parses `dcode.json` with
  `appConfigSchema.strict()` instead of `.partial()`. The `.partial()` call
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
