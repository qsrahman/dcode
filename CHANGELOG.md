# Changelog

All notable changes to **dcode** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

### Changed
- Version is read from package.json at runtime via `createRequire` instead of
  a hardcoded constant in `index.ts`.

### Fixed
- `createClient` now applies `config.maxRetries` to the OpenAI client and
  `config.maxTokens` as `max_output_tokens` on each request; both were defined
  in the schema but previously ignored. (`toolTimeout` stays unused until P3,
  where it gates per-tool execution, not the SDK request.)
- System prompt: `agent/system.ts` defines a base system message injected
  into every run (`buildSystemPrompt`), stating dcode's role, working-directory
  scope, and that tool output is untrusted data.

## [0.1.0] - 2026-08-17

### Added

- Config layer: zod schema (`config/schema.ts`), JSON file loading, and a pure
  CLI > env > file > defaults merge (`config/config.ts`).
- CLI argument parsing (`cli/args.ts`): `--model/-m`, `--mode`, `--auto`,
  `--plan`, `--config/-c`, `--no-stream`, `--no-color`, `--verbose`,
  `--version/-v`, `--help/-h`, plus a positional one-shot prompt.
- OpenAI Responses client wrapper (`agent/client.ts`): stream + one-shot, behind
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
