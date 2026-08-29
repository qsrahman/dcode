import type { Client, OpenAIResponse, ResponseInput } from './client.ts'
import { isContextOverflowError } from './client.ts'
import type { Config } from '../config/schema.ts'
import { resolveRoot } from '../config/config.ts'
import { buildSystemPrompt } from './system.ts'
import type { Logger } from '../util/log.ts'
import type { RunSink } from './run.ts'
import { runTurn, runTool } from './run.ts'
import type { ToolContext, ToolResult } from './types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import ansis from 'ansis'
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import { ContextManager } from './context/manager.ts'

// Agent loop: run turns, execute any tool calls the model makes, feed the
// results back, and repeat up to `maxToolIterations` (decision D). Every turn
// streams its text live to `sink`; tool results are rendered between turns.
// Returns the final assistant text.
//
// Tool outputs are grouped into a single block (no blank line between them).
// A turn that follows a tool call gets a leading blank line so its streamed
// text is visually separated from the tool-output block above it.

export async function runAgent(
  client: Client,
  config: Config,
  history: ResponseInput,
  opts: {
    sink?: RunSink
    logger: Logger
    signal?: AbortSignal
    tools?: ToolRegistry
    context?: ContextManager
  },
): Promise<string> {
  const sink = opts.sink ?? process.stdout
  const registry = opts.tools ?? new ToolRegistry()
  const ctx: ToolContext = {
    root: resolveRoot(config),
    config,
    logger: opts.logger,
    signal: opts.signal,
  }
  const responses = registry.list().length
    ? registry.toResponsesTools()
    : undefined
  // Durable system guidance lives in the Responses API `instructions` field,
  // not in the conversation `history`, so it isn't trimmed or replayed as a turn.
  const instructions = buildSystemPrompt(config)
  // One streaming turn; hoisted so the context-overflow retry reuses it instead
  // of duplicating the call.
  const runOnce = () =>
    runTurn(client, config, history, {
      sink,
      logger: opts.logger,
      tools: responses,
      instructions,
      signal: opts.signal,
    })
  let finalText = ''
  let prevHadTools = false

  for (let i = 0; i < config.maxToolIterations; i++) {
    // Before each request, shrink the history if it's near the model's context
    // limit (prune old tool outputs, else summarize the oldest history).
    if (opts.context) {
      const action = await opts.context.beforeTurn(client, config, history)
      if (action !== 'none') {
        opts.logger.debug(
          'context: %s (now ~%d tokens)',
          action,
          opts.context.predict(history),
        )
      }
    }
    // Every turn streams live to `sink`. A turn that follows a tool call gets a
    // leading blank line so its text is separated from the tool-output block.
    if (prevHadTools) sink.write('\n')
    let response: OpenAIResponse
    try {
      ;({ text: finalText, response } = await runOnce())
    } catch (err) {
      // The request exceeded the context window. Compact and retry once; if that
      // still overflows (or the breaker is tripped) let it fail normally.
      if (
        opts.context &&
        isContextOverflowError(err) &&
        (await opts.context.onOverflow(client, config, history))
      ) {
        ;({ text: finalText, response } = await runOnce())
      } else {
        throw err
      }
    }
    // Recalibrate the token estimate against the provider's real usage.
    opts.context?.observe(response.usage, history)
    // toResponseInputItems normalizes response.output into items safe to
    // replay as the next turn's input, including reasoning items — required
    // by reasoning models (the GPT-5 family, o-series) on every stateless
    // turn (store: false, dcode's default against real OpenAI) that
    // continues a tool call. A hand-rolled reconstruction that only kept
    // function_call items silently dropped them.
    //
    // It doesn't strip `parsed_arguments` from function_call items, though —
    // confirmed live: the API rejects a replayed function_call carrying it
    // ("Unknown parameter: 'input[N].parsed_arguments'"). The field isn't
    // even in the SDK's own ResponseFunctionToolCall type, so this is
    // stripped explicitly rather than relying on the SDK's normalizer.
    history.push(
      ...toResponseInputItems(response.output ?? []).map(stripParsedArguments),
    )
    const calls = (response.output ?? []).filter(
      (o): o is ResponseFunctionToolCall => o.type === 'function_call',
    )
    if (calls.length === 0) break
    prevHadTools = true
    const results = await runCalls(calls, registry, ctx)
    for (const { id, outcome } of results) {
      history.push({
        type: 'function_call_output',
        call_id: id,
        output: outcome.output,
      })
      sink.write(`${renderToolResult(outcome.name, outcome.ok, outcome.ms)}\n`)
      if (config.verbose)
        sink.write(`${renderToolOutput(outcome.name, outcome.output)}\n`)
    }
    // Abort only after every call has a recorded output, so history stays
    // balanced (no function_call without its function_call_output) and the
    // conversation can be resumed. handleLine catches this and logs `aborted`.
    if (opts.signal?.aborted) throw new Error('aborted')
  }
  return finalText
}

// The Responses API rejects a function_call item replayed with a
// `parsed_arguments` field ("Unknown parameter"), but toResponseInputItems
// doesn't strip it — the field isn't part of the SDK's own
// ResponseFunctionToolCall type, so its generic normalizer doesn't know to.
function stripParsedArguments(item: ResponseInputItem): ResponseInputItem {
  if (item.type !== 'function_call' || !('parsed_arguments' in item)) {
    return item
  }
  const { parsed_arguments: _parsedArguments, ...rest } =
    item as typeof item & {
      parsed_arguments?: unknown
    }
  return rest as ResponseInputItem
}

// One-shot orchestration: a single user turn through the agent loop. Builds the
// input (system + user) and delegates to runAgent. Returns the final text.
export async function runOneShot(
  client: Client,
  config: Config,
  prompt: string,
  opts: {
    sink?: RunSink
    logger: Logger
    tools?: ToolRegistry
    signal?: AbortSignal
  },
): Promise<string> {
  const context = new ContextManager(config.context, opts.logger)
  const input: ResponseInput = [{ role: 'user', content: prompt }]
  return runAgent(client, config, input, { ...opts, context })
}

// Execute one turn's tool calls in the order the model emitted them. Parallel-
// eligible calls (read-only tools; `parallel !== false`) are batched via
// Promise.all; non-parallel calls (mutating tools) run one at a time in emission
// order. Every call yields exactly one outcome — an unknown-tool error, an
// `aborted` marker if the user cancelled before it ran, or the tool's real
// result — so history and rendering stay aligned and every function_call gets a
// function_call_output.
async function runCalls(
  calls: ResponseFunctionToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<{ id: string; outcome: ToolResult }[]> {
  const results: { id: string; outcome: ToolResult }[] = []
  let batch: ResponseFunctionToolCall[] = []

  const runOne = async (
    c: ResponseFunctionToolCall,
  ): Promise<{ id: string; outcome: ToolResult }> => {
    const call = { id: c.call_id, name: c.name, arguments: c.arguments }
    const tool = registry.get(c.name)
    let outcome: ToolResult
    if (ctx.signal?.aborted) {
      outcome = {
        id: c.call_id,
        name: c.name,
        output: 'aborted',
        ok: false,
        ms: 0,
      }
    } else if (!tool) {
      outcome = {
        id: c.call_id,
        name: c.name,
        output: `error: unknown tool "${c.name}"`,
        ok: false,
        ms: 0,
      }
    } else {
      outcome = await runTool(call, tool, ctx)
    }
    return { id: c.call_id, outcome }
  }

  // Flush the accumulated parallel batch, preserving emission order.
  const flush = async () => {
    if (batch.length === 0) return
    const outs = await Promise.all(batch.map(runOne))
    results.push(...outs)
    batch = []
  }

  for (const c of calls) {
    const tool = registry.get(c.name)
    if (tool && tool.parallel !== false) {
      batch.push(c)
    } else {
      await flush()
      results.push(await runOne(c))
    }
  }
  await flush()
  return results
}

export function renderToolResult(
  name: string,
  ok: boolean,
  ms: number,
): string {
  const status = ok ? ansis.green('✓') : ansis.red('✗')
  const secs = (ms / 1000).toFixed(1)
  return `› ${ansis.cyan(name)}: ${status} ${ok ? 'done' : 'failed'} (${ansis.dim(secs + 's')})`
}

const RULE = '─'.repeat(40)

// Color a unified-diff line so edits and `git diff` output are scannable in
// verbose mode: hunk headers cyan, additions green, removals red.
function colorDiffLine(line: string): string {
  if (line.startsWith('@@')) return ansis.cyan(line)
  if (line.startsWith('+')) return ansis.green(line)
  if (line.startsWith('-')) return ansis.red(line)
  return line
}

// Verbose mode echoes a tool's raw output between turns; dim fences mark it
// as diagnostics so it doesn't read as more streamed model text. Diff-like
// lines (from git diff or edit_file) are colored.
export function renderToolOutput(name: string, output: string): string {
  const body = output.split('\n').map(colorDiffLine).join('\n')
  return [ansis.dim(`── ${name} output ${RULE}`), body, ansis.dim(RULE)].join(
    '\n',
  )
}
