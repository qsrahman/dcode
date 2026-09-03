import { createClient } from '../src/agent/client.ts'
import { runAgent } from '../src/agent/loop.ts'
import type { ResponseInput } from '../src/agent/client.ts'
import { buildConfig } from '../src/config/config.ts'
import { parseCli } from '../src/cli/args.ts'
import { createLocalTools } from '../src/tools/index.ts'
import { TaskStore } from '../src/agent/todo-store.ts'
import { ContextManager } from '../src/agent/context/manager.ts'
import { CapturingSink } from '../src/agent/run.ts'
import { createLogger, errorMessage } from '../src/util/log.ts'
import { stripVTControlCharacters } from 'node:util'

// Live end-to-end stress test. Talks to the real model (configured via the
// global config, env, or CLI flags) and drives the real agent loop + tools over
// THIS repository. Not part of the unit suite: run it explicitly with
// `pnpm stress`. Exercises tool iteration, truncation, context compaction
// (proactive + todo-aware), mutating writes, background processes,
// ripgrep-backed grep/glob, web search/fetch, the todowrite list, sub-agents
// (the task tool), and concurrent runs — and verifies the UI/UX spacing of
// the rendered output (exactly one well-formed line per tool call) plus the
// markdown rendering of the streamed answer.
//
// `ask_user` is deliberately never exercised: it blocks on a real keypress,
// which would hang an unattended run.

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
      'Read src/agent/types.ts with the read_file tool and describe the Tool interface in one paragraph.',
  },
  {
    name: 'broad-explore',
    prompt:
      'Explore the dcode source under src/. Use list_dir on src, glob for every "**/*.ts" file, then grep for the word "Tool" across them, and summarize where the tools are defined and registered.',
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

async function runScenario(
  client: ReturnType<typeof createClient>,
  config: ReturnType<typeof buildConfig>,
  logger: ReturnType<typeof createLogger>,
  tools: ReturnType<typeof createLocalTools>,
  tasks: TaskStore,
  scenario: Scenario,
): Promise<void> {
  const history: ResponseInput = [{ role: 'user', content: scenario.prompt }]
  const sink = new CapturingSink()
  // Exercise the full context pipeline (observe + beforeTurn) so compaction is
  // covered too; per-run so each history calibrates its own token estimate.
  const context = new ContextManager(config.context, logger, tasks)
  const t0 = Date.now()
  const text = await runAgent(client, config, history, {
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
  const status = ok ? 'ok ' : 'EMPTY'
  console.log(
    `[${status}] ${scenario.name.padEnd(18)} toolCalls=${calls} outputs=${outputs} ` +
      `streamed=${Buffer.byteLength(sink.text)} finalLen=${text.trim().length} time=${dt}ms`,
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
  const config = buildConfig(parseCli(process.argv.slice(2)))
  const logger = createLogger(config)
  const client = createClient(config)
  const tasks = new TaskStore()
  const tools = createLocalTools(tasks, client)

  console.log(
    `live stress: model=${config.model} baseURL=${config.baseURL ?? '(default)'} ` +
      `root=${config.root ?? process.cwd()} maxToolIterations=${config.maxToolIterations}`,
  )
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
  const start = Date.now()
  for (const s of scenarios) {
    try {
      await runScenario(client, config, logger, tools, tasks, s)
    } catch (err) {
      failed++
      console.log(`[FAIL] ${s.name}: ${errorMessage(err)}`)
    }
    console.log('')
  }

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

  const total = Date.now() - start
  console.log(`total time=${total}ms  failures=${failed}`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(errorMessage(err))
  process.exit(1)
})
