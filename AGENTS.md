# AGENTS.md — Developer guide

How to build and extend **dcode**. Read this before changing code.

## Stack constraints (non-negotiable)

- **Node 26+** type stripping: no `tsc` build, `node src/index.ts` runs it.
- **TypeScript 7+**, strict, ESM (`"type": "module"`).
- **pnpm only** — never `npm` or `yarn`.
- Builtins imported with the `node:` prefix (`node:fs`, `node:path`, `node:os`).
- Relative imports use the `.ts` extension (`import { x } from './y.ts'`).
- Type-only imports use `import type` (`verbatimModuleSyntax` is on).
- **No `enum` / runtime `namespace` / parameter properties / `import x = require()`**
  — Node's strip-only mode rejects them. Use `const` objects + union types.

## Scripts

```sh
pnpm dev          # node --watch src/index.ts
pnpm test         # vitest run
pnpm test:watch   # vitest
pnpm typecheck    # tsc --noEmit  (gate)
pnpm format       # prettier --write .
pnpm format:check # prettier --check . (gate)
pnpm stress       # live end-to-end stress test (scripts/live-stress.ts)
```

## Code style

Enforced by Prettier (`.prettierrc`): no semicolons until necessary, single
quotes, trailing commas, 2-space indent. Run `pnpm format` before committing;
`pnpm format:check` gates CI. `*.md` is excluded from formatting (`.prettierignore`),
so docs stay hand-formatted.

## Comments

Explain **why**, never **what**. No line-by-line narration. Targeted comments only
where the intent isn't obvious from the code.

## Commits

One focused commit per change. After every significant change, review and update
`PLAN.md`, `README.md`, and this file when it affects features, CLI flags,
architecture, or conventions.

## Diagnostics vs output

- `console.log` / `process.stdout` is reserved for **streamed model output** and the
  **interactive REPL prompt** only.
- All other diagnostics go to **stderr** via `util/log.ts` — `createLogger(config)`
  returns `{ debug, warn, error }`, where `debug` is gated by `config.verbose` and
  `warn`/`error` always emit. Color comes from the `ansis`
  dependency (disabled when `config.color` is false). `--verbose` also echoes
  each tool call's raw output to the terminal (in addition to stderr
  diagnostics) — see README's flag reference.

## Configuration sources

Config is resolved with precedence **CLI > env > global (`~/.config/dcode/dcode.json`) > schema defaults**:

- File: `~/.config/dcode/dcode.json` (global), or an explicit `--config <path>`.
  JSON, validated by `config/schema.ts` (zod). dcode is a globally installed
  personal tool, so there is no repo-local config discovery.
- Env: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` (read from the process
  environment; the same values can be persisted in `dcode.json` instead).
- CLI flags (`--model`, `--no-color`, `--verbose`) override the above.

`config/config.ts` holds the pure `mergeConfigs` (tested) plus thin `loadConfig`
and `buildConfig` wrappers.

## Testing

- Tests in `tests/`, mirroring `src/` (`tests/cli/args.test.ts` -> `src/cli/args.ts`).
- Prefer fast, deterministic unit tests over network integration.
- Mock external boundaries (OpenAI client, `child_process`, `fs` side effects).
- For colored output, assert against `ansis.strip(...)`.
- Same code style as `src/`.

## Module layout

See [PLAN.md](./PLAN.md) §5 for the authoritative module tree and the agent-loop
description. The 12 locked design decisions are in PLAN.md §6 — do not reopen them
without explicit agreement.

`grep`/`glob` (`tools/local/search.ts`) spawn `rgPath` directly instead of going
through `exec.ts`'s `runExec`, unlike every other tool that shells out. This is
deliberate, not an inconsistency to "fix": ripgrep's exit-code convention (0 =
matches, 1 = ran fine, nothing found — neither is an error) doesn't fit
`runExec`'s throw-on-nonzero contract. Both tools share a local `runRg` helper
with the correct exit-code handling instead.

## Security model

dcode grants the model your own shell access on your own machine (`run_shell`,
`run_process`) by design — there is no approval/sandboxing layer (P5 was
cancelled; see the top-level CLAUDE.md). Anything reachable from your machine —
localhost services, your local network, cloud metadata endpoints if you're on a
cloud VM — is already in scope through those tools. `web_fetch`/`web_search`
deliberately have no additional host/IP restriction on top of that: a guard
there alone wouldn't meaningfully reduce risk while `run_shell` remains
unrestricted, so this is a conscious choice, not an oversight. If that trust
boundary ever needs to shrink (e.g. a future sandboxed mode), it has to shrink
for `run_shell`/`run_process` first — restricting `web_fetch` on its own
wouldn't accomplish anything.

## Phase workflow

1. Implement the phase's code.
2. Add deterministic tests.
3. Update `PLAN.md` / `README.md` / `AGENTS.md` if the change touches features,
   CLI flags, architecture, or conventions.
4. Bump the version: once per completed phase, increment the **minor** in
   `package.json` (`0.x.0`) and move the CHANGELOG `## [Unreleased]` section to a
   dated `## [x.y.0] - YYYY-MM-DD` entry. (Patch/major follow SemVer as needed.)
5. `pnpm typecheck && pnpm format:check && pnpm test`.
6. Commit (one focused commit, including the version bump and CHANGELOG release).
