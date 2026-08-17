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
- All other diagnostics go to **stderr** via `util/log.ts` (guarded by `--verbose`).

## Configuration sources

Config is resolved with precedence **CLI > env > file > schema defaults**:

- File: `./dcode.json` (or `.dcode.json`), or `--config <path>`. JSON, validated
  by `config/schema.ts` (zod).
- Env: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_DEFAULT_MODEL` (Node 26 loads
  `.env` via `--env-file` in `dev`/`start`).
- CLI flags (`--model`, `--mode`, `--no-stream`, `--no-color`, `--verbose`,
  `--auto`, `--plan`) override the above.

`config/config.ts` holds the pure `mergeConfig` (tested) plus thin `loadConfigFile`
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

## Phase workflow

1. Implement the phase's code.
2. Add deterministic tests.
3. Update `PLAN.md` / `README.md` / `AGENTS.md` if the change touches features,
   CLI flags, architecture, or conventions.
4. `pnpm typecheck && pnpm format:check && pnpm test`.
5. Commit (one focused commit).
