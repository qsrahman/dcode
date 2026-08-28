# dcode

A CLI-based AI coding agent built on the OpenAI Responses SDK. Runs locally, no
build step (Node 26 runs TypeScript directly).

> Status: **P10 complete** — one-shot, the interactive REPL, the tool-using
> agent loop (read-only and mutating tools), an in-session task list, a scoped
> `git` tool, and automatic context-window management all work. See
> [PLAN.md](./PLAN.md) for the full roadmap.

> **⚠️ Security warning — tools are ungated.** dcode has **no permission
> architecture**. Every tool, including mutating ones (`write_file`, `edit_file`,
> `run_shell`, and `git` `commit`/`branch`), runs **automatically** the moment the
> model calls it — there is no confirmation prompt, allow-list, sandbox, or
> dry-run mode. The model can edit files and execute arbitrary shell commands in
> the working directory entirely on its own initiative. **Use with caution:**
> point dcode only at sandboxed or disposable directories, and review its
> actions. A declarative permissions/modes system was planned (P5) but cancelled.

## Requirements

- Node.js **26+** (type stripping — no `tsc` build step).
- [pnpm](https://pnpm.io).

## Environment variables

`dcode` reads these from the process environment (export them in your shell, or
persist them in `dcode.json` via `/key` for a global install):

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | API key (required). If unset, dcode prints setup guidance and exits. |
| `OPENAI_BASE_URL` | Override the API base URL (OpenAI-compatible endpoints). |
| `OPENAI_MODEL` | Default model id when not set in config or `--model`. |
| `DCODE_CONFIG_HOME` | Directory holding the global `dcode.json` (default `~/.config/dcode`). |

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
| `--config <path>` | Path to a JSON config file. |
| `--verbose` | Verbose diagnostics (stderr) and echoes tool results to the terminal. |
| `--no-color` | Disable colored output. |
| `--version` | Print version and exit. |
| `--help` | Print help and exit. |

### REPL slash commands

`/help` `/key` `/model` `/tools` `/clear` `/reset` `/compact` `/context` `/tasks`
`/config` `/undo` `/verbose` `/version` `/exit`

 (`/clear` clears the screen; `/reset` drops the conversation history. `/model`
 with no argument prints the current model; `/model <id>` switches it. `/tools`
 lists the tools the agent can call. `/compact` summarizes the oldest part of the
 conversation into a short summary to free context; `/context` shows the estimated
 token usage against the model's window. `/tasks` lists the in-session task list;
 `/config` prints the effective configuration; `/undo` removes the last user
 exchange (prompt + response); `/verbose` toggles verbose mode, optionally
 `/verbose on|off`.)

 The REPL supports tab-completion: slash commands complete from the list above,
 and the last whitespace-delimited token is completed as a file path under the
 working directory. In `--verbose` mode, tool-status lines are colorized and any
 diff output (e.g. `git diff`) is shown with colored additions/removals.

### Tools

The agent can call a small set of tools, confined to the working directory
(`root`). Tool calls run in the order the model emits them; results are fed back
to the model and the loop repeats up to `maxToolIterations` (default 16).

| Tool | Purpose |
|------|---------|
| `read_file` | Read a UTF-8 text file under the working directory. |
| `list_dir` | List a directory under the working directory. |
| `grep` | Search file contents for a regular expression. |
| `stat` | Report type/size/mtime of a file or directory. |
| `glob` | List files matching a glob pattern (`**` recursive). |
| `write_file` | Create or overwrite a UTF-8 text file. |
| `edit_file` | Replace an exact, unique string in a file (`replace_all` to change all). |
| `run_shell` | Run a shell command in the working directory (`cwd=root`, `toolTimeout`). |
| `web_search` | Search the web via Brave (`BRAVE_API_KEY` required). |
| `web_fetch` | Fetch a URL and return its content (HTML → Markdown, JSON pretty-printed); no API key required. |
| `todo` | Manage the in-session task list (add / list / update / done) to plan and track multi-step work. |
| `git` | Scoped git operations: `status`, `diff`, `log`, `show`, `add`, `commit`, `branch` (in the working directory). |
| `move_file` | Move/rename a file or directory under the working directory. |
| `copy_file` | Copy a file under the working directory. |
| `delete_file` | Delete a file or (with `recursive`) a directory under the working directory. |
| `make_dir` | Create a directory (and parents) under the working directory. |
| `run_process` | Spawn a background process and return a handle. |
| `read_process` | Tail a background process's output and exit status. |
| `kill_process` | Stop a background process by handle. |

`web_search` needs a Brave Search API key in the `BRAVE_API_KEY` environment
variable; without it the tool returns an error instead of crashing. The recursive tools (`grep`, `glob`) skip paths matching `ignore`
(default `.git`, `node_modules`; gitignore syntax, so globs like `*.log` and
negation also work), and `grep` caps its output at 200 matches.
Tool output is untrusted data; results are truncated to `maxToolOutputBytes`
(default 32 KiB), and tool errors are returned to the model so it can
self-correct. In-flight tools (including `run_shell`) are cancelled on Ctrl-C.
The `todo` tool holds an in-session list the model uses to plan and track work;
the list is in-memory only and is cleared by `/reset` (and listed with `/todo`).

**Context-window management.** Long sessions are kept within `context.window`:
before each request, dcode prunes old tool outputs (collapsing them to a short
marker) and, once the estimate crosses `context.compactAt` of the usable budget
(default 0.85), summarizes the oldest history into a single `user` message
while keeping a recent tail verbatim — *proactively*, before a context-length
error forces a retry. The summary is produced by a separate model call whose
instruction also includes the session's authoritative task list (from the `todo`
tool), so the summary can't contradict what was actually tracked. The token
estimate is calibrated against the real `usage` the API returns, so no tokenizer
dependency is needed. If a request still exceeds the window, dcode compacts and
retries once. Set `context.window` to match your model (lower it for small local
models); `/compact` triggers a summary on demand and `/context` reports usage.

## Configuration (`dcode.json`)

JSON, loaded from `--config <path>` or a default location. Example:

```json
{
  "model": "gpt-5.4-mini",
  "maxToolIterations": 16,
  "maxHistoryItems": 100,
  "maxToolOutputBytes": 32768,
  "stateful": false,
  "ignore": [".git", "node_modules"],
  "context": { "window": 200000, "reserved": 20000, "keepTokens": 15000, "compactAt": 0.85 }
}
```

Config resolution precedence is: CLI flags > env (`OPENAI_*`) > global
`DCODE_CONFIG_HOME`/`~/.config/dcode/dcode.json` > schema defaults. An explicit
`--config <path>` replaces the global file (and a missing path is an error). The
global config is the canonical store for a globally installed `dcode`, so a fixed
`model`/`baseURL`/`apiKey` applies no matter which directory you run it from.

API keys (`OPENAI_API_KEY`, `BRAVE_API_KEY`) are read from the environment
(first), then the global config (`apiKey` / `brave` fields), then the schema
default. For a global install, store them once without editing JSON
or exporting them per shell: start `dcode` and run `/key set openai <key>`
(and `/key set brave <key>` for web search). `/key` writes the key to
`~/.config/dcode/dcode.json` with `0600` permissions and never prints it back;
`/key list` shows which providers are set without revealing values.

See [PLAN.md](./PLAN.md) for the full schema and the locked design decisions.

## Phases

| Phase | Scope | Status |
|-------|-------|--------|
| P0 | Scaffold & tooling | **Done** |
| P1 | Config + OpenAI client + one-shot | **Done** |
| P2 | REPL + slash commands | **Done** |
| P3 | Tool core + read-only tools + async loop | **Done** |
| P4 | Mutating local tools | **Done** |
| P5 | Declarative permissions + modes | **Cancelled** |
| P6 | MCP integration | |
| P7 | Polish (verbose/stderr, --no-color, SIGINT, docs pass) | **Done** |
| P8 | Task list (in-session: create/list/update) | **Done** |
| P9 | Git tool (scoped status/diff/log/show/add/commit/branch) | **Done** |
| P10 | Context-window management (prune + compact + overflow retry) | **Done** |
| P11 | File lifecycle (move/copy/delete/mkdir) + background process tools | **Done** |
| P12 | Symbol search (`find_symbol` / `find_references`) | **Planned** |
| P13 | `apply_patch` (atomic multi-file unified-diff apply) | **Planned** |

## Development

- Standard tasks: `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm format`.
- `pnpm stress` runs a **live** end-to-end stress test (`scripts/live-stress.ts`):
  it drives the real agent loop and tools against the configured model
  (Ollama via env or `dcode.json`) with heavy sequential scenarios plus a concurrency burst.
  It requires a reachable model endpoint and is intentionally outside the unit
  suite so `pnpm test` stays offline.

## License

Internal / MIT (TBD).
