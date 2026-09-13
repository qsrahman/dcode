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
- **Don't hand-roll functions, types/interfaces if a built-in or an already-
  included library/package provides the same capability.** Check `node:*`
  builtins, the OpenAI SDK (`openai`), `zod`, `execa`, `marked`, etc. before
  writing a utility. If the runtime or a dependency already covers the need,
  use it — even if the hand-rolled version is slightly simpler in isolation.

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
  `warn`/`error` always emit. Color comes from `util/color.ts`'s `paintFor`
  (see "Module layout"), driven by `config.color`. `--verbose` also echoes
  each tool call's raw output to the terminal (in addition to stderr
  diagnostics) — see README's flag reference.

## Configuration sources

Config is resolved with precedence **CLI > env > global (`~/.config/dcode/dcode.json`) > schema defaults**:

- File: `~/.config/dcode/dcode.json` (global), or an explicit `--config <path>`.
  JSON, validated by `config/schema.ts` (zod). dcode is a globally installed
  personal tool, so there is no repo-local config discovery.
- Env: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `BRAVE_API_KEY`
  (read from the process environment; the same values can be persisted in
  `dcode.json` instead).
- CLI flags (`--model`, `--no-color`, `--verbose`) override the above.

`config/config.ts` holds `buildConfig` (layers file + env + args in one place,
tested) plus `readConfigFile` (path resolution + strict parse) and
`globalConfigPath`/`normalizeBaseURL` helpers.

Unknown input is rejected at every layer, not tolerated: `configSchema.strict()`
rejects a typo'd config key (including inside `context`), and `parseCli` runs
`parseArgs` in strict mode so a typo'd flag is an error. The lenient mode it
used before was not merely forgiving — `--modle gpt-4 "do a thing"` dropped the
flag *and* swallowed its value into the positionals, silently running the
default model against the prompt `"gpt-4 do a thing"`.

Add a flag by adding one entry to `cli/args.ts`'s `FLAGS` table: it feeds both
the `parseArgs` options and `formatFlags()`, which renders `--help`. Don't
write the help text separately — the previous hand-written block had already
lost all four short forms (`-m`, `-c`, `-v`, `-h`).

Nested schema defaults: zod hands a `.default()` value back **verbatim**, it
does not re-parse it. A literal default object for a nested schema is
therefore a second copy of that schema's field defaults, and the two diverge
silently — omitting the key yields the literal while passing `{}` yields the
field defaults. `configSchema`'s `context` derives its default with
`contextSchema.default(() => contextSchema.parse({}))` instead. Note that
`.default({})` does *not* work here for the same reason: it would be returned
as-is, giving an empty object with none of the fields.

`/key` (`cli/keys.ts`'s `setGlobalKey`/`unsetGlobalKey`) always writes to
`globalConfigPath()`, never to whatever `--config <path>` a session was
launched with — `--config` only changes where config is *read* from at
startup. This is intentional (there's no per-`--config` secret store), but
worth remembering when touching `/key`: it updates `session.config` in
memory for the current session, so it still works there, but a later
`--config <path>` run without the env var set won't see it.

## Testing

- Tests in `tests/`, mirroring `src/` (`tests/cli/args.test.ts` -> `src/cli/args.ts`).
- Prefer fast, deterministic unit tests over network integration.
- Mock external boundaries (OpenAI client, `child_process`, `fs` side effects).
- For colored output, assert against `node:util`'s `stripVTControlCharacters(...)`.
- Same code style as `src/`.

## Module layout

See [PLAN.md](./PLAN.md) §5 for the authoritative module tree and the agent-loop
description. The 12 locked design decisions are in PLAN.md §6 — do not reopen them
without explicit agreement.

`grep`/`glob` (`tools/local/search.ts`) spawn `rgPath` directly instead of
going through `exec.ts`, unlike every other tool that shells out. This is
deliberate, not an inconsistency to "fix": ripgrep's exit-code convention (0 =
matches, 1 = ran fine, nothing found — neither is an error) doesn't fit a
throw-on-nonzero contract. Both tools share a local `runRg` helper with the
correct exit-code handling instead. Their `-g` argument order is also
load-bearing: `config.ignore` patterns go *after* the caller's own patterns,
because ripgrep resolves competing globs last-match-wins.

Define a tool with `tools/registry.ts`'s `defineTool`, which infers the
argument type from its zod schema. Don't write a `ToolDefinition<{...}>`
annotation alongside the schema: the two have nothing keeping them in sync,
and a tool that omits the annotation falls back to `P = unknown` and needs an
unchecked `args as {...}` cast, which cannot fail to compile when the schema
changes.

Colour goes through `util/color.ts`'s `paintFor(color)` — the one place
`styleText` is applied. Take the flag from `config.color`; never let Node
auto-detect. Detection runs at startup, before `--no-color` reaches argv, and
it reports on stdout rather than the sink being written to.

`runTool` (`agent/run.ts`) races every tool against `config.toolTimeout` and
`ctx.signal` via `withDeadline`. Losing that race **abandons** the tool
promise — nothing can force a tool to stop from the outside — so a tool that
spawns or connects must also take `ctx.signal` itself (`baseExecOptions`'
`cancelSignal`, `fetchSafely`'s combined signal) if the underlying resource is
to be released rather than merely orphaned. A tool that blocks on input must
refuse up front when it can't succeed (see `ask_user`'s TTY check) rather than
relying on the deadline to tidy up.

## Security model

dcode grants the model your own shell access on your own machine (`run_shell`,
`run_process`) by design — there is no approval/sandboxing layer (P5 was
cancelled; see the top-level CLAUDE.md). Anything reachable from your machine —
localhost services, your local network, cloud metadata endpoints if you're on a
cloud VM — is already in scope through those tools, and that isn't changing.

`web_fetch` is no exception, and deliberately so. It reaches whatever the URL
resolves to — loopback, LAN, and cloud-metadata endpoints included — with no
host filtering, matching opencode's model where network containment is the
surrounding sandbox's job rather than the tool's. dcode earlier carried a
resolve-then-check guard (`assertPublicHost`) that rejected private/internal
addresses; it was removed because it was a partial mitigation (fail-open, and
defeated by DNS rebinding since global `fetch` re-resolves after the check)
sitting in front of a process that already grants unrestricted `run_shell`,
so it raised the apparent bar without meaningfully shrinking the real attack
surface. The boundary that actually matters is the same one `run_shell`
defines: **don't point dcode at untrusted input or untrusted networks.** If
that boundary ever needs to shrink, it shrinks with a real sandbox (network
namespace, connect-time filtering), not an in-process host check. See
`tools/local/http.ts`'s header comment.

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
