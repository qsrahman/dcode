# dcode

A CLI-based AI coding agent built on the OpenAI Responses SDK. Runs locally, no
build step (Node 26 runs TypeScript directly).

> Status: **P3 complete** — one-shot, the interactive REPL, and the tool-using
> agent loop (read-only tools) all work. Permissions and mutating tools land in
> P4/P5. See [PLAN.md](./PLAN.md) for the full roadmap.

## Requirements

- Node.js **26+** (type stripping — no `tsc` build step).
- [pnpm](https://pnpm.io).

## Environment variables

`dcode` reads these from the environment (loaded automatically via Node 26's
`--env-file=.env` in `dev`/`start`, or your shell):

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | API key (required). Falls back to the SDK default if unset. |
| `OPENAI_BASE_URL` | Override the API base URL (OpenAI-compatible endpoints). |
| `OPENAI_DEFAULT_MODEL` | Default model id when not set in config or `--model`. |

## Install (from source)

```sh
pnpm install
pnpm link              # makes `dcode` available on your PATH
```

## Usage

```sh
dcode "add a --verbose flag to src/cli/args.ts"   # one-shot
dcode                                                # REPL
```

### Flags

| Flag | Description |
|------|-------------|
| `--model <id>` | Model id (default: latest flagship; overridable in config). |
| `--mode <interactive\|auto\|plan>` | Permission mode. |
| `--auto` | Shorthand for `--mode auto`. |
| `--plan` | Shorthand for `--mode plan`. |
| `--config <path>` | Path to a JSON config file. |
| `--verbose` | Verbose diagnostics (stderr) and echoes tool results to the terminal. |
| `--no-color` | Disable colored output. |
| `--version` | Print version and exit. |
| `--help` | Print help and exit. |

### REPL slash commands

`/help` `/model` `/tools` `/clear` `/reset` `/version` `/exit`

(`/clear` clears the screen; `/reset` drops the conversation history. `/model`
with no argument prints the current model; `/model <id>` switches it. `/tools`
lists the tools the agent can call.)

### Tools (read-only, P3)

The agent can call a small set of read-only tools, confined to the working
directory (`root`). Tool calls are executed in parallel, their results fed back
to the model, and the loop repeats up to `maxToolIterations` (default 16).

| Tool | Purpose |
|------|---------|
| `read_file` | Read a UTF-8 text file under the working directory. |
| `list_dir` | List a directory under the working directory. |
| `grep` | Search file contents for a regular expression. |
| `stat` | Report type/size/mtime of a file or directory. |
| `glob` | List files matching a glob pattern (`**` recursive). |

Tool output is untrusted data; results are truncated to `maxToolOutputBytes`
(default 32 KiB), and tool errors are returned to the model so it can
self-correct.

## Configuration (`dcode.json`)

JSON, loaded from `--config <path>` or a default location. Example:

```json
{
  "model": "gpt-5",
  "maxToolIterations": 16,
  "maxHistoryItems": 100,
  "maxToolOutputBytes": 32768,
  "permissions": {
    "mode": "interactive",
    "rules": {
      "shell": "ask",
      "write_file": "ask"
    }
  },
  "mcp": [
    {
      "name": "fs-extra",
      "transport": { "type": "stdio", "command": "node", "args": ["./mcp/fs-server.ts"] },
      "trust": false
    }
  ]
}
```

See [PLAN.md](./PLAN.md) for the full schema and the locked design decisions.

## Phases

| Phase | Scope |
|-------|-------|
| P0 | Scaffold & tooling |
| P1 | Config + OpenAI client + one-shot |
| P2 | REPL + slash commands | **Done** |
| P3 | Tool core + read-only tools + async loop | **Done** |
| P4 | Mutating local tools |
| P5 | Declarative permissions + modes |
| P6 | MCP integration |
| P7 | Polish |

## Development

- Standard tasks: `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm format`.
- `pnpm stress` runs a **live** end-to-end stress test (`scripts/live-stress.ts`):
  it drives the real agent loop and read-only tools against the configured model
  (Ollama via `.env`) with heavy sequential scenarios plus a concurrency burst.
  It requires a reachable model endpoint and is intentionally outside the unit
  suite so `pnpm test` stays offline.

## License

Internal / MIT (TBD).
