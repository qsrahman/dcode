# dcode

A CLI-based AI coding agent built on the OpenAI Responses SDK. Runs locally, no
build step (Node 26 runs TypeScript directly).

> Status: **P11 + P6 complete** — one-shot, the interactive REPL, the
> tool-using agent loop (read-only and mutating tools), an in-session todo
> list, sub-agents, automatic context-window management, and MCP server
> integration all work. See [PLAN.md](./PLAN.md) for the full roadmap.

> **⚠️ Security warning — tools are ungated.** dcode has **no permission
> architecture**. Every tool, including mutating ones (`write_file`, `edit_file`,
> `delete_file`, `run_shell`), runs **automatically** the moment the
> model calls it — there is no confirmation prompt, allow-list, sandbox, or
> dry-run mode. Sub-agents launched with `task` run the same ungated tools.
> The model can edit files and execute arbitrary shell commands in
> the working directory entirely on its own initiative. **Use with caution:**
> point dcode only at sandboxed or disposable directories, and review its
> actions. A declarative permissions/modes system was planned (P5) but
> cancelled. This includes MCP servers: any tool a configured server exposes
> runs exactly as ungated as dcode's own built-in tools.

## Requirements

- Node.js **26+** (type stripping — no `tsc` build step).
- [pnpm](https://pnpm.io).

## Environment variables

`dcode` reads these from the process environment (export them in your shell, or
persist them in `dcode.json` via `/key` for a global install):

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | API key (required). If unset, dcode prompts for one on an interactive terminal and saves it to the global config; otherwise it prints setup guidance and exits. |
| `OPENAI_BASE_URL` | Override the API base URL (OpenAI-compatible endpoints). |
| `OPENAI_MODEL` | Default model id when not set in config or `--model`. |
| `BRAVE_API_KEY` | Brave Search key for `web_search` (or store it with `/key set brave`). |
| `XDG_CONFIG_HOME` | Base config directory (default `~/.config`); the global config lives at `$XDG_CONFIG_HOME/dcode/dcode.json`. A relative value is ignored per the XDG spec. |

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
| `-m`, `--model <id>` | Model id (default: latest flagship; overridable in config). |
| `-c`, `--config <path>` | Path to a JSON config file. |
| `--verbose` | Verbose diagnostics (stderr) and echoes tool results to the terminal. |
| `--no-color` | Disable colored output. |
| `-v`, `--version` | Print version and exit. |
| `-h`, `--help` | Print help and exit. |

An unrecognized flag is an error rather than being ignored. To pass a prompt
that begins with `-`, put it after `--`:

```sh
dcode -- "--this reads as a prompt, not a flag"
```

### REPL slash commands

`/help` `/key` `/model` `/tools` `/mcp` `/clear` `/reset` `/compact` `/context`
`/tasks` `/todo` `/config` `/undo` `/version` `/limit` `/edit` `/save` `/exit`

 (`/clear` clears the screen; `/reset` drops the conversation history and
 requires an explicit `/reset confirm` — there is no undo, so it refuses a
 bare `/reset` and points at `/save`. `/model`
 with no argument prints the current model; `/model <id>` switches it. `/tools`
 lists the tools the agent can call (built-in and MCP-sourced alike); `/mcp`
 lists configured MCP servers and whether each connected, with its tool count
 (or the connection error, if it didn't). `/compact` summarizes the oldest part of the
 conversation into a short summary to free context; `/context` shows the estimated
 token usage against the model's window. `/tasks` lists the in-session task list;
 `/config` prints the effective configuration; `/undo` removes the last user
 exchange (prompt + response); `/save [path.md|path.json]` writes the
 transcript out (refusing to overwrite an existing file); `/limit <n>` sets
 `maxToolIterations` (the per-query tool-call ceiling) at runtime. `/edit` opens your `$VISUAL`/`$EDITOR` on a scratch
 buffer and sends whatever you write when the editor closes — handy for
 composing long or multi-line prompts, which paste into the line editor as
 separate submissions otherwise; it reports how to set an editor if neither
 variable is configured.)

 Ctrl-C cancels the turn in flight. With nothing running, a single Ctrl-C
 prints a hint and a second one within two seconds exits, matching the
 convention of bash, Python, and Node's own REPL.

 The REPL supports tab-completion: slash commands complete from the list above,
 and the last whitespace-delimited token is completed as a file path under the
 working directory. While a turn calls tools, the terminal shows a single live
 counter that updates in place and then settles into a one-line summary grouped
 by tool family (e.g. `2 search · 13 read · 8.5s`) above the answer, so a turn
 that makes many tool calls stays one line rather than scrolling. In `--verbose`
 mode (or when output is piped) that compact summary is replaced by one status
 line per call, colorized, and any diff output (e.g. a `git diff` run through
 `run_shell`) is shown with colored additions/removals.
 Assistant responses are rendered as styled markdown while streaming
 (headings, bold/italic, lists, syntax-highlighted code blocks) — a code
 block or other block-level construct isn't shown until it's complete, so
 partial markdown syntax is never visible mid-stream.

### Tools

The agent can call a small set of tools, confined to the working directory
(`root`). Tool calls run in the order the model emits them; results are fed back
to the model and the loop repeats up to `maxToolIterations` (default 16). Hitting
that cap with tool calls still pending leaves the conversation fully resumable —
raise it with `/limit <n>` and send a follow-up prompt (e.g. "continue") to pick
up where it left off, the same trick the REPL prints as a hint when it happens.
(A dedicated `/continue` command that resumes without a throwaway prompt isn't
built yet.)

| Tool | Purpose |
|------|---------|
| `read_file` | Read a UTF-8 text file under the working directory. |
| `list_dir` | List a directory under the working directory. |
| `grep` | Search file contents for a regular expression (ripgrep-backed). |
| `stat` | Report type/size/mtime of a file or directory. |
| `glob` | List files matching a glob pattern (ripgrep-backed; `**` recursive). |
| `write_file` | Create or overwrite a UTF-8 text file. |
| `edit_file` | Replace an exact, unique string in a file (`replace_all` to change all). |
| `run_shell` | Run a shell command in the working directory (`cwd=root`, `toolTimeout`). |
| `web_search` | Search the web via Brave (`BRAVE_API_KEY` required). |
| `web_fetch` | Fetch a URL and return its content (`format`: `markdown` default → HTML to Markdown + pretty JSON, or `text`/`html` unconverted); no API key required. |
| `todowrite` | Replace the in-session todo list (the model sends the whole list each call) to plan and track multi-step work. |
| `ask_user` | Ask the user a multiple-choice or free-text question mid-run (interactive terminals only). |
| `task` | Delegate self-contained work to a sub-agent (`general` or `explore`) with its own context. |
| `move_file` | Move/rename a file or directory under the working directory. |
| `copy_file` | Copy a file under the working directory. |
| `delete_file` | Delete a file or (with `recursive`) a directory under the working directory. |
| `make_dir` | Create a directory (and parents) under the working directory. |
| `run_process` | Spawn a background process and return a handle. |
| `read_process` | Tail a background process's output and exit status. |
| `kill_process` | Stop a background process by handle. |

`web_search` needs a Brave Search API key in the `BRAVE_API_KEY` environment
variable (or `/key set brave <key>`); without it the tool returns an error
instead of crashing, and an in-flight search is cancelled on Ctrl-C like every
other tool. The recursive tools (`grep`, `glob`) are both backed by
[ripgrep](https://github.com/BurntSushi/ripgrep) (bundled via
`@vscode/ripgrep` — no separate install needed) and skip paths matching
`ignore` (default `.git`, `node_modules`; gitignore syntax, so globs like
`*.log` and negation also work). `grep` patterns are Rust regex syntax (no
lookaround/backreferences), matches are capped at 200, and files above 5 MiB
are skipped. `glob` patterns are gitignore-style globs — unlike a plain glob
library, a bare pattern with no `/` (e.g. `*.ts`) matches at any depth, not
just the top level; anchor with a leading `/` for root-only. `read_file`'s
`offset`/`limit` paging reads up to 8 MiB of a file to find the requested
lines; an offset past that window errors instead of silently reading as
end-of-file.
Tool output is untrusted data; results are truncated to `maxToolOutputBytes`
(default 32 KiB), and tool errors are returned to the model so it can
self-correct. In-flight tools (including `run_shell`) are cancelled on Ctrl-C.
The `todowrite` tool holds an in-session list the model uses to plan and track
work; the model sends the entire list on every call, so its view and dcode's
can't drift apart. The list is in-memory only and is cleared by `/reset` (and
listed with `/tasks` or `/todo`).

`ask_user` pauses the run to ask a question (single- or multi-select, with an
optional free-text answer). It needs an interactive terminal: with piped or
redirected stdin it returns immediately, telling the model to proceed on its
own judgement, rather than blocking on a keypress that will never come.

The `task` tool runs a **sub-agent** — a nested agent loop with its own
history, its own todo list, and only the tools its agent type allows:
`explore` is read-only (search, read, web), `general` gets everything except
`task` itself. Sub-agents can't spawn sub-agents, they run one at a time
rather than in parallel, their output isn't streamed to the terminal (only the
final result returns to the parent), and each call starts from a fresh
context — there is no way to resume one.

**Context-window management.** Long sessions are kept within `context.window`:
before each request, dcode prunes old tool outputs (collapsing them to a short
marker) and, once the estimate crosses `context.compactAt` of the usable budget
(default 0.85), summarizes the oldest history into a single `user` message
while keeping a recent tail verbatim — *proactively*, before a context-length
error forces a retry. The summary is produced by a separate model call whose
instruction also includes the session's authoritative task list (from
`todowrite`), so the summary can't contradict what was actually tracked. The token
estimate is calibrated against the real `usage` the API returns, so no tokenizer
dependency is needed. If a request still exceeds the window, dcode compacts and
retries once. Set `context.window` to match your model (lower it for small local
models); `/compact` triggers a summary on demand and `/context` reports usage.

This proactive compaction is the **only** thing that bounds conversation history
(there is no separate item-count cap). Setting `context.auto: false` disables it,
with real consequences: history then grows unbounded — every turn's request gets
larger, costlier, and slower — and nothing shrinks it ahead of time. Recovery
becomes purely reactive: a request eventually overflows the window, after which
dcode prunes/compacts and retries once (so you pay for the oversized failed
request *plus* the compaction), and if that fails to make progress three times in
a row the session stops recovering and requests fail until you `/reset` or
`/compact`. Only disable `auto` for short or one-shot sessions that never approach
the window; leave it on (the default) otherwise.

## MCP servers

dcode connects to any MCP (Model Context Protocol) servers named under
`mcpServers` in `dcode.json` and exposes their tools to the agent alongside
its own built-in ones — the loop, `task`'s sub-agent filtering, and `/tools`
all treat an MCP-sourced tool identically to a built-in. Two transports:

```json
{
  "mcpServers": {
    "local-server": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    },
    "remote-server": {
      "enabled": true,
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_SERVER_TOKEN}" }
    }
  }
}
```

**`enabled` defaults to `false`** — a server sitting in `dcode.json` (the
global config, so it's visible from every project dcode runs in) doesn't
connect until you opt in. This also makes it cheap to keep a server's config
around without it running: flip `enabled` instead of deleting and re-adding
the whole entry. `/mcp` shows a disabled server as `disabled` rather than
omitting it, and `/config` reports how many of the configured servers are
actually enabled.

`type` (`"local"` or `"remote"`) can be given explicitly but is usually
inferred from whichever of `command`/`url` is present. A `local` server's
`env` is merged on top of dcode's own filtered environment (the same ambient
secret-stripping `run_shell` gets), so the server keeps PATH/HOME/etc. while
still receiving whatever secret it needs explicitly. A `remote` server takes
only static `headers` — there is no OAuth flow. A `headers`/`env` value that
is *exactly* `${VAR_NAME}` (whole value, not embedded in a larger string) is
expanded from your shell's environment at connect time instead of being read
literally — so a server's secret can live outside `dcode.json` entirely; an
unset variable fails just that server's connection with a clear error rather
than sending a broken literal or blocking every other configured server.

Every configured server connects in parallel at startup (both one-shot and
REPL) and is closed on exit or Ctrl-C. A server that fails to connect or list
its tools is logged as a warning and skipped rather than blocking startup —
check `/mcp` to see which servers connected and how many tools each exposed.
Tool names are qualified as `mcp__<server>__<tool>` to avoid collisions
across servers. **The same "no permission layer" warning above applies in
full:** an MCP tool runs exactly as ungated as `run_shell` the moment the
model calls it, so only configure servers you trust.

## Configuration (`dcode.json`)

JSON, loaded from `--config <path>` or a default location. Example:

```json
{
  "model": "gpt-5.4-mini",
  "maxToolIterations": 16,
  "maxToolOutputBytes": 32768,
  "stateful": false,
  "ignore": [".git", "node_modules"],
  "context": { "window": 200000, "reserved": 20000, "keepTokens": 15000, "compactAt": 0.85 }
}
```

Config resolution precedence is: CLI flags > env (`OPENAI_*`) > global
`$XDG_CONFIG_HOME/dcode/dcode.json` (default `~/.config/dcode/dcode.json`) >
schema defaults. An explicit
`--config <path>` replaces the global file (and a missing path is an error). The
global config is the canonical store for a globally installed `dcode`, so a fixed
`model`/`baseURL`/`apiKey` applies no matter which directory you run it from.

API keys (`OPENAI_API_KEY`, `BRAVE_API_KEY`) are read from the environment
(first), then the global config (`apiKey` / `braveApiKey` fields), then the schema
default. For a global install, store them once without editing JSON
or exporting them per shell: start `dcode` and run `/key set openai <key>`
(and `/key set brave <key>` for web search). `/key` always writes to
`~/.config/dcode/dcode.json` with `0600` permissions and never prints it back —
even in a session started with `--config <path>`, which only changes where
dcode *reads* its config from, not where `/key` *writes* to. A key set via
`/key` during a `--config` session takes effect for that session (it updates
`session.config` directly) but won't persist into `<path>` itself; the
command's own output always names the actual file it wrote. `/key list`
shows which providers are set without revealing values.

Two optional model-tuning keys, both unset by default (the provider's default
applies and nothing extra is sent): `reasoningEffort`
(`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, sent as
`reasoning.effort`; lower values make a reasoning model explore less before
acting) and `verbosity` (`low`/`medium`/`high`, sent as `text.verbosity`;
controls answer length). They apply to agent turns and sub-agents, not to
compaction, and which values a model accepts is up to the provider. `/config`
shows the effective values.

See [PLAN.md](./PLAN.md) for the full schema and the locked design decisions.

## Project instructions

If the working directory has an `AGENTS.md` (or, failing that, a `CLAUDE.md`),
dcode appends its contents to the system prompt at the start of each prompt, so
edits take effect on your next message. Only the current directory is read
(not parent directories), an empty file is ignored, and a file over 32,000
characters is truncated with a note. It applies to the main agent and the
`general` sub-agent. **Only run dcode in repositories you trust:** with no
permission layer, instructions in a cloned repo's `AGENTS.md` steer a model
that can run any shell command.

## Phases

| Phase | Scope | Status |
|-------|-------|--------|
| P0 | Scaffold & tooling | **Done** |
| P1 | Config + OpenAI client + one-shot | **Done** |
| P2 | REPL + slash commands | **Done** |
| P3 | Tool core + read-only tools + async loop | **Done** |
| P4 | Mutating local tools | **Done** |
| P5 | Declarative permissions + modes | **Cancelled** |
| P6 | MCP integration | **Done** |
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
  (Ollama via env or `dcode.json`) with heavy sequential scenarios plus a concurrency burst,
  and also connects whatever MCP servers are configured (same as a real session — a
  failed/unreachable one just shows as `failed` in the startup report). It requires a
  reachable model endpoint and is intentionally outside the unit suite so `pnpm test`
  stays offline.

## License

Internal / MIT (TBD).
