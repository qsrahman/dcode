# dcode

A CLI-based AI coding agent built on the OpenAI Responses SDK. Runs locally, no
build step (Node 26 runs TypeScript directly).

> Status: **scaffold (P0)**. The agent itself lands in later phases. See
> [PLAN.md](./PLAN.md) for the full roadmap.

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
| `DCODE_MODEL` | Default model id when not set in config or `--model`. |

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
| `--no-stream` | Disable streaming. |
| `--verbose` | Verbose diagnostics (to stderr). |
| `--no-color` | Disable colored output. |
| `--version` | Print version and exit. |
| `--help` | Print help and exit. |

### REPL slash commands

`/help` `/model` `/mode` `/clear` `/reset` `/tools` `/version` `/exit`

(`/clear` clears the screen; `/reset` drops the conversation history.)

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
| P2 | REPL + slash commands |
| P3 | Tool core + read-only tools + async loop |
| P4 | Mutating local tools |
| P5 | Declarative permissions + modes |
| P6 | MCP integration |
| P7 | Polish |

## License

Internal / MIT (TBD).
