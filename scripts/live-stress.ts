import { createClient } from '../src/agent/client.ts'
import { runAgent } from '../src/agent/loop.ts'
import { buildSystemPrompt } from '../src/agent/system.ts'
import type { ResponseInput } from '../src/agent/client.ts'
import { buildConfig } from '../src/config/config.ts'
import { parseCli } from '../src/cli/args.ts'
import { createLocalTools } from '../src/tools/index.ts'
import { CapturingSink } from '../src/agent/run.ts'
import { createLogger, errorMessage } from '../src/util/log.ts'
import ansis from 'ansis'

// Live end-to-end stress test. Talks to the real model (configured via .env)
// and drives the real agent loop + tools over THIS repository. Not part of the
// unit suite: run it explicitly with `node --env-file-if-exists=.env
// scripts/live-stress.ts`. Exercises tool iteration, truncation, auto-approved
// writes, web search, and concurrent runs, and verifies the UI/UX spacing of
// the rendered output (exactly one well-formed line per tool call).

type Item = { type?: string; [k: string]: unknown }

function count(history: ResponseInput, type: string): number {
  return (history as Item[]).filter((h) => h.type === type).length
}

interface Scenario {
  name: string
  prompt: string
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
]

// UI/UX spacing check: each tool call must render exactly one well-formed,
// line-separated status line. Catches missing/duplicated renders and any
// regression in the per-tool output spacing.
function checkUiSpacing(name: string, out: string, toolOutputs: number): void {
  const clean = ansis.strip(out)
  const toolLines = clean.split('\n').filter((l) => l.startsWith('› '))
  if (toolLines.length !== toolOutputs) {
    throw new Error(
      `${name}: UI/UX: expected ${toolOutputs} tool-result lines, got ${toolLines.length}`,
    )
  }
  const malformed = toolLines.find(
    (l) => !/^› [^:]+: [\u2713\u2717] done \(\d+\.\d+s\)$/.test(l),
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
  scenario: Scenario,
): Promise<void> {
  const history: ResponseInput = [
    { role: 'system', content: buildSystemPrompt(config) },
    { role: 'user', content: scenario.prompt },
  ]
  const sink = new CapturingSink()
  const t0 = Date.now()
  const text = await runAgent(client, config, history, { logger, sink, tools })
  const dt = Date.now() - t0
  const calls = count(history, 'function_call')
  const outputs = count(history, 'function_call_output')
  checkUiSpacing(scenario.name, sink.text, outputs)
  if (config.verbose) process.stdout.write(sink.text)
  const ok = text.trim().length > 0
  const status = ok ? 'ok ' : 'EMPTY'
  console.log(
    `[${status}] ${scenario.name.padEnd(18)} toolCalls=${calls} outputs=${outputs} ` +
      `streamed=${Buffer.byteLength(sink.text)} finalLen=${text.trim().length} time=${dt}ms`,
  )
  if (!ok) throw new Error(`${scenario.name}: model returned empty answer`)
}

async function main(): Promise<void> {
  const config = buildConfig(parseCli(process.argv.slice(2)))
  const logger = createLogger(config)
  const client = createClient(config)
  const tools = createLocalTools()

  console.log(
    `live stress: model=${config.model} baseURL=${config.baseURL ?? '(default)'} ` +
      `root=${config.root ?? process.cwd()} maxToolIterations=${config.maxToolIterations}`,
  )
  console.log('')

  let failed = 0
  const start = Date.now()
  for (const s of scenarios) {
    try {
      await runScenario(client, config, logger, tools, s)
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
        await runScenario(client, config, logger, tools, s)
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
