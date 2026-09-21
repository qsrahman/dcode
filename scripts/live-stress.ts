import { createRuntime } from '../src/agent/runtime.ts'
import type { Runtime } from '../src/agent/runtime.ts'
import { runAgent } from '../src/agent/loop.ts'
import type { ResponseInput } from '../src/agent/client.ts'
import { buildConfig } from '../src/config/config.ts'
import { parseCli } from '../src/cli/args.ts'
import { formatMcpServers } from '../src/cli/commands.ts'
import { TaskStore } from '../src/agent/types.ts'
import { ContextManager } from '../src/agent/context/manager.ts'
import { CapturingSink } from '../src/ui/sink.ts'
import { createLogger, errorMessage } from '../src/util/log.ts'
import { stripVTControlCharacters } from 'node:util'

// Live end-to-end stress test. Talks to the real model (configured via the
// global config, env, or CLI flags) and drives the real agent loop + tools over
// THIS repository. Not part of the unit suite: run it explicitly with
// `pnpm stress`. Exercises tool iteration, truncation, context compaction
// (proactive + todo-aware), mutating writes, background processes,
// ripgrep-backed grep/glob, web search/fetch, the todowrite list, sub-agents
// (the task tool), project-instructions loading (AGENTS.md in the system
// prompt), MCP servers configured in the global config (connected the
// same way index.ts/repl.ts do — best-effort, a bad/unreachable server just
// shows as 'failed' rather than failing the whole run), and concurrent runs
// — and verifies the UI/UX spacing of the rendered output (exactly one
// well-formed line per tool call) plus the markdown rendering of the
// streamed answer.
//
// The UI checks below assert the stable one-line-per-call form, which
// ui/tools.ts only uses off a TTY (an interactive TTY gets the live/frozen
// summary instead). Pin it so the run means the same thing from a terminal
// as from a pipe.
Object.defineProperty(process.stdout, 'isTTY', { value: false })

// Usage: `pnpm stress [scenario ...] [burst]` — with no names, everything runs;
// otherwise only the named scenarios (and the concurrency burst, when `burst`
// is listed). Handy for re-running just what failed.
//
// `ask_user` is deliberately never exercised: it blocks on a real keypress,
// which would hang an unattended run.

let narrationWarnings = 0

type Item = { type?: string; [k: string]: unknown }

function count(history: ResponseInput, type: string): number {
  return (history as Item[]).filter((h) => h.type === type).length
}

function toolNames(history: ResponseInput): string[] {
  return (history as Item[])
    .filter((h) => h.type === 'function_call')
    .map((h) => String(h.name))
}

// What a scenario's `check` gets: everything observable about the run.
interface RunFacts {
  history: ResponseInput
  // Streamed output, ANSI already stripped.
  out: string
  text: string
  tasks: TaskStore
}

interface Scenario {
  name: string
  prompt: string
  // Optional semantic assertion beyond "answered non-empty". Throw to fail.
  check?: (facts: RunFacts) => void
}

function requireTool(facts: RunFacts, name: string): void {
  const called = toolNames(facts.history)
  if (!called.includes(name)) {
    throw new Error(`expected the model to call ${name}, got [${called}]`)
  }
}

const scenarios: Scenario[] = [
  {
    name: 'narrow-read',
    prompt:
      'Read src/agent/types.ts with the read_file tool and describe the ToolDefinition interface in one paragraph.',
  },
  {
    name: 'broad-explore',
    prompt:
      'Explore the dcode source under src/. Use read_file on the src directory to list it, glob for every "**/*.ts" file, then grep for the word "Tool" across them, and summarize where the tools are defined and registered.',
  },
  {
    name: 'large-grep',
    prompt:
      'Run grep for the token "import" across the entire repository and report roughly how many matches there are and which files dominate.',
  },
  {
    name: 'shell-write-read',
    prompt:
      'Use the run_shell tool to write the text "dcode-stress" into /tmp/dcode-stress.txt and then print its contents back to me, then tell me what you wrote.',
  },
  {
    name: 'deep-chain',
    prompt:
      'Find the file that defines runAgent, read it, then grep the whole repo to list every caller of runAgent and report the call sites.',
  },
  {
    name: 'web-search',
    prompt:
      'Use the web_search tool to look up the current Node.js LTS version and report the version number in one sentence.',
  },
  {
    name: 'background-process',
    prompt:
      'Use run_process to run `echo dcode-bg-hello` in the background, wait a moment, then use read_process to fetch its output and report exactly what it printed.',
  },
  {
    name: 'web-fetch',
    prompt:
      'Use the web_fetch tool to read https://example.com and report the page heading in one sentence.',
    check: (f) => requireTool(f, 'web_fetch'),
  },
  {
    name: 'todo-plan',
    prompt:
      'Use the todowrite tool to record a three-step plan for adding a --quiet flag to src/cli/args.ts (do not actually edit anything), then tell me the plan. Mark the first step in_progress.',
    check: (f) => {
      requireTool(f, 'todowrite')
      // The store is the session's source of truth for compaction, so a
      // todowrite that doesn't land there is a real (silent) failure.
      const todos = f.tasks.list()
      if (todos.length === 0)
        throw new Error('TaskStore is empty after todowrite')
      const bad = todos.find((t) => !t.content || !t.status || !t.priority)
      if (bad) throw new Error(`malformed todo: ${JSON.stringify(bad)}`)
    },
  },
  {
    name: 'sub-agent',
    // Stated as a hard constraint, not a suggestion: the system prompt tells
    // the model to prefer doing simple work itself rather than delegating, so
    // a softer phrasing gets answered with a direct grep/glob instead and the
    // sub-agent path never runs.
    prompt:
      'Delegate this to a sub-agent — you must call the task tool with subagent_type "explore", and you must not call grep, glob, or read_file yourself. Ask the sub-agent to find every file under src/tools/local that defines a ToolDefinition. Report the list it returns.',
    check: (f) => {
      requireTool(f, 'task')
      // Sub-agent output goes to a silent sink; only the parent's own single
      // `task` status line may appear for it.
      if (/task_result|task_error/.test(f.out)) {
        throw new Error('sub-agent transcript leaked into the parent sink')
      }
    },
  },
  {
    // The repo's AGENTS.md is loaded into the system prompt (agent/system.ts),
    // so the model can answer this with no tool call at all. A tool call, or a
    // wrong answer, means the project instructions didn't reach the model.
    name: 'project-instructions',
    prompt:
      'Without calling any tools: according to the project instructions you were given, which package manager must be used in this repository? Answer in one sentence.',
    check: (f) => {
      const called = toolNames(f.history)
      if (called.length > 0) {
        throw new Error(`expected no tool calls, got [${called}]`)
      }
      if (!/pnpm/i.test(f.text)) {
        throw new Error(`answer doesn't mention pnpm: ${f.text.slice(0, 120)}`)
      }
    },
  },
  {
    name: 'markdown-render',
    prompt:
      'Answer with a level-2 markdown heading, a bulleted list with one **bold** item, and a fenced python code block whose body contains a blank line between two statements. No other commentary.',
    check: (f) => {
      // The renderer converts markdown to ANSI, so raw syntax reaching the
      // terminal means a block was emitted unrendered. Headings are NOT
      // checked: marked-terminal deliberately keeps a heading's leading `#`
      // characters as a plain-text hierarchy cue (they're styled, not
      // stripped), so `## Heading` in the output is correct, not a miss.
      if (f.out.includes('**')) {
        throw new Error(
          'literal ** reached the terminal (inline markdown unrendered)',
        )
      }
      if (f.out.includes('```')) {
        throw new Error('literal ``` fence reached the terminal')
      }
    },
  },
]

// UI/UX spacing check: each tool call must render exactly one well-formed,
// line-separated status line. Catches missing/duplicated renders and any
// regression in the per-tool output spacing.
function checkUiSpacing(name: string, out: string, toolOutputs: number): void {
  const clean = stripVTControlCharacters(out)
  const toolLines = clean.split('\n').filter((l) => l.startsWith('› '))
  if (toolLines.length !== toolOutputs) {
    throw new Error(
      `${name}: UI/UX: expected ${toolOutputs} tool-result lines, got ${toolLines.length}`,
    )
  }
  const malformed = toolLines.find(
    (l) => !/^› [^:]+: [\u2713\u2717] (?:done|failed) \(\d+\.\d+s\)$/.test(l),
  )
  if (malformed) {
    throw new Error(
      `${name}: UI/UX: malformed tool line: ${JSON.stringify(malformed)}`,
    )
  }
}

// The system prompt tells the model not to narrate between tool calls (the
// summary freeze in ui/tools.ts assumes tool turns emit no text). In the
// per-call form, a tool turn's text lands before its `› ` lines, so any
// non-blank text above the last tool line is narration. Model behaviour, not
// a code invariant, so this warns rather than fails.
function narrationLines(out: string): string[] {
  const lines = stripVTControlCharacters(out).split('\n')
  const lastTool = lines.findLastIndex((l) => l.startsWith('› '))
  return lines
    .slice(0, Math.max(lastTool, 0))
    .filter((l) => l.trim() !== '' && !l.startsWith('› '))
}

async function runScenario(
  client: Runtime['client'],
  config: ReturnType<typeof buildConfig>,
  logger: ReturnType<typeof createLogger>,
  tools: Runtime['tools'],
  tasks: TaskStore,
  scenario: Scenario,
): Promise<void> {
  const history: ResponseInput = [{ role: 'user', content: scenario.prompt }]
  const sink = new CapturingSink()
  // Exercise the full context pipeline (observe + beforeTurn) so compaction is
  // covered too; per-run so each history calibrates its own token estimate.
  const context = new ContextManager(config.context, logger, tasks)
  const t0 = Date.now()
  const { text, truncated } = await runAgent(client, config, history, {
    logger,
    sink,
    tools,
    context,
  })
  const dt = Date.now() - t0
  const calls = count(history, 'function_call')
  const outputs = count(history, 'function_call_output')
  checkUiSpacing(scenario.name, sink.text, outputs)
  checkReplayShape(scenario.name, history)
  if (config.verbose) process.stdout.write(sink.text)
  const ok = text.trim().length > 0
  const narration = narrationLines(sink.text)
  narrationWarnings += narration.length
  const status = ok ? 'ok ' : 'EMPTY'
  console.log(
    `[${status}] ${scenario.name.padEnd(18)} toolCalls=${calls} outputs=${outputs} ` +
      `streamed=${Buffer.byteLength(sink.text)} finalLen=${text.trim().length} time=${dt}ms` +
      (truncated ? ' truncated=true (hit maxToolIterations)' : '') +
      (narration.length ? ` narration=${narration.length}` : ''),
  )
  if (!ok) throw new Error(`${scenario.name}: model returned empty answer`)
  scenario.check?.({
    history,
    out: stripVTControlCharacters(sink.text),
    text,
    tasks,
  })
}

// History is replayed verbatim as the next turn's input, so anything the API
// rejects on replay has to be caught here rather than on the next request.
// Two invariants: every function_call is paired with its output (an orphan is
// a hard 400), and no function_call carries `parsed_arguments` (the SDK adds
// it to responses; loop.ts's stripParsedArguments removes it again).
function checkReplayShape(name: string, history: ResponseInput): void {
  const items = history as Item[]
  const callIds = new Set(
    items.filter((h) => h.type === 'function_call').map((h) => h.call_id),
  )
  const outputIds = new Set(
    items
      .filter((h) => h.type === 'function_call_output')
      .map((h) => h.call_id),
  )
  for (const id of callIds) {
    if (!outputIds.has(id)) {
      throw new Error(`${name}: function_call ${String(id)} has no output`)
    }
  }
  for (const id of outputIds) {
    if (!callIds.has(id)) {
      throw new Error(`${name}: orphaned output for call ${String(id)}`)
    }
  }
  const leaked = items.find(
    (h) => h.type === 'function_call' && 'parsed_arguments' in h,
  )
  if (leaked) {
    throw new Error(`${name}: function_call still carries parsed_arguments`)
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  // Bare arguments are scenario names (parseCli folds positionals into the
  // prompt, which a stress run has no use for).
  const only = cli.prompt?.split(' ') ?? []
  const unknown = only.filter(
    (n) => n !== 'burst' && !scenarios.some((s) => s.name === n),
  )
  if (unknown.length) {
    throw new Error(
      `unknown scenario(s): ${unknown.join(', ')} (known: ${scenarios.map((s) => s.name).join(', ')}, burst)`,
    )
  }
  const selected = only.length
    ? scenarios.filter((s) => only.includes(s.name))
    : scenarios
  const runBurst = only.length === 0 || only.includes('burst')

  const config = buildConfig(cli)
  // A load test bursts past provider rate limits (429 on tokens per minute);
  // the default handful of retries all land inside the same one-minute window.
  // Retry more so the SDK's backoff outlasts it.
  config.maxRetries = Math.max(config.maxRetries, 8)
  const logger = createLogger(config)
  // The same runtime a real session gets, MCP servers included: they're closed
  // on the way out regardless of how the run finishes. A server that's
  // unreachable or missing an env-var secret (see manager.ts's
  // expandEnvPlaceholder) degrades to a 'failed' status rather than aborting
  // the whole stress run — the scenarios below don't depend on any specific
  // MCP server being up.
  const { client, tasks, mcp, tools } = await createRuntime(config, logger)

  console.log(
    `live stress: model=${config.model} baseURL=${config.baseURL ?? '(default)'} ` +
      `root=${process.cwd()} maxToolIterations=${config.maxToolIterations} maxRetries=${config.maxRetries} ` +
      `reasoning=${config.reasoningEffort ?? '(default)'} verbosity=${config.verbosity ?? '(default)'}`,
  )
  console.log(formatMcpServers(mcp.servers))
  // A leftover placeholder key ("ollama") is harmless against a local endpoint
  // but 401s against OpenAI's default baseURL with a confusing message. Warn
  // before spending a full run on it.
  const looksLocal = /localhost|127\.0\.0\.1|ollama/i.test(config.baseURL ?? '')
  if ((config.apiKey ?? '').trim().toLowerCase() === 'ollama' && !looksLocal) {
    console.log(
      'warning: apiKey is the placeholder "ollama" and baseURL is not a local ' +
        'endpoint — requests will likely 401. Set a real key via OPENAI_API_KEY ' +
        'or run `dcode` and use `/key set openai <key>`.',
    )
  }
  console.log('')

  let failed = 0
  try {
    const start = Date.now()
    for (const s of selected) {
      try {
        await runScenario(client, config, logger, tools, tasks, s)
      } catch (err) {
        failed++
        console.log(`[FAIL] ${s.name}: ${errorMessage(err)}`)
      }
      console.log('')
    }

    if (runBurst) {
      // Concurrency burst: run several scenarios in parallel to stress the shared
      // client/streaming and confirm runs don't cross-contaminate (each has its own
      // history/input).
      console.log('concurrency burst (3 parallel runs):')
      const burst = scenarios.slice(0, 3)
      const burstStart = Date.now()
      const results = await Promise.all(
        burst.map(async (s) => {
          try {
            await runScenario(client, config, logger, tools, tasks, s)
            return true
          } catch (err) {
            console.log(`[FAIL] ${s.name}: ${errorMessage(err)}`)
            return false
          }
        }),
      )
      failed += results.filter((r) => !r).length
      console.log(`burst time=${Date.now() - burstStart}ms`)
      console.log('')
    }

    const total = Date.now() - start
    console.log(
      `total time=${total}ms  failures=${failed}  narration warnings=${narrationWarnings}`,
    )
  } finally {
    // process.exit() below (if reached) skips any code after it, `finally`
    // included, so mcp.close() has to run before that call, not rely on it —
    // moved here rather than left as `if (failed > 0) process.exit(1)`
    // inline above, which would have left connected MCP servers (a spawned
    // stdio child, an open HTTP connection) dangling on any failed run.
    await mcp.close()
  }
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(errorMessage(err))
  process.exit(1)
})
