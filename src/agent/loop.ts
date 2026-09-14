import type { Client, OpenAIResponse, ResponseInput } from './client.ts'
import { isContextOverflowError } from './client.ts'
import type { Config } from '../config/schema.ts'
import { buildSystemPrompt } from './system.ts'
import type { Logger } from '../util/log.ts'
import type { RunSink } from './run.ts'
import { runTurn, runTool } from './run.ts'
import { createToolProgress } from '../ui/tools.ts'
import type { ToolContext, ToolDefinition, ToolResult } from './types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import { ContextManager } from './context/manager.ts'

type TurnResult = { text: string; response: OpenAIResponse }

// A context overflow is recovered by compacting and retrying; a truncated
// response by injecting "Continue." and retrying. Both are bounded so a
// pathological turn can't retry forever.
const OVERFLOW_RETRIES = 3
const CONTINUE_RETRIES = 3

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
    depth?: number
    instructions?: string
  },
): Promise<string> {
  const sink = opts.sink ?? process.stdout
  const registry = opts.tools ?? new ToolRegistry()
  const ctx: ToolContext = {
    root: process.cwd(),
    config,
    logger: opts.logger,
    signal: opts.signal,
    depth: opts.depth,
  }
  const responses = registry.list().length
    ? registry.toResponsesTools()
    : undefined
  // Durable system guidance lives in the Responses API `instructions` field,
  // not in the conversation `history`, so it isn't trimmed or replayed as a turn.
  const instructions = opts.instructions ?? buildSystemPrompt()
  // All terminal rendering of tool progress lives here (see ui/tools.ts). It
  // freezes just before the first answer chunk (onBeforeText), reliably because
  // intermediate reasoning turns emit no visible text.
  const progress = createToolProgress(sink, config)
  const runOnce = (): Promise<TurnResult> =>
    runTurn(client, config, history, {
      sink,
      logger: opts.logger,
      tools: responses,
      instructions,
      signal: opts.signal,
      onBeforeText: progress.freeze,
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
    progress.separate(prevHadTools)

    const { text, response } = await completeTurn({
      runOnce,
      context: opts.context,
      client,
      config,
      history,
      logger: opts.logger,
    })
    finalText = text
    // Recalibrate the token estimate against the provider's real usage.
    opts.context?.observe(response.usage, history)
    pushResponseOutput(history, response)

    const calls = functionCalls(response)
    if (calls.length === 0) break
    prevHadTools = true

    const results = await runCalls(calls, registry, ctx, progress.onResult)
    appendToolOutputs(history, results)
    progress.renderBatch(results)

    // Abort only after every call has a recorded output, so history stays
    // balanced (no function_call without its function_call_output) and the
    // conversation can be resumed. handleLine catches this and logs `aborted`.
    // Freeze first so the tools that did run leave a clean summary behind.
    if (opts.signal?.aborted) {
      progress.freeze()
      throw new Error('aborted')
    }
    // Still calling tools on the final permitted iteration: the loop is about
    // to stop mid-task and return whatever text that turn happened to
    // produce, which for a pure tool-call turn is nothing at all. Say so —
    // silently handing back an empty answer reads as the model having no
    // reply, rather than as a ceiling the user can raise.
    if (i === config.maxToolIterations - 1) {
      opts.logger.warn(
        'stopped after %d tool iterations (maxToolIterations) with work still in progress; raise maxToolIterations or narrow the request',
        config.maxToolIterations,
      )
    }
  }
  // Normally onBeforeText has already frozen the summary above the final
  // answer; this catches a query that ends on tools with no closing text
  // (an empty final answer, or the maxToolIterations ceiling above).
  progress.freeze()
  return finalText
}

// Run one streaming turn, recovering from two provider-side conditions before
// returning: a context overflow (compact and retry) and a truncated response
// (max_output_tokens — inject "Continue." and retry so the model can finish).
async function completeTurn(deps: {
  runOnce: () => Promise<TurnResult>
  context?: ContextManager
  client: Client
  config: Config
  history: ResponseInput
  logger: Logger
}): Promise<TurnResult> {
  const { context, client, config, history, logger } = deps

  // One request attempt, with an overflow routed into compact-and-retry. Used
  // for both the initial request and every "Continue." retry, so a retry that
  // itself overflows is recovered rather than surfacing raw.
  const requestTurn = async (): Promise<TurnResult> => {
    try {
      return await deps.runOnce()
    } catch (err) {
      if (!(context && isContextOverflowError(err))) throw err
      return recoverFromOverflow(
        deps.runOnce,
        context,
        client,
        config,
        history,
        err,
      )
    }
  }

  let result = await requestTurn()
  let continues = 0
  while (
    result.response.incomplete_details?.reason === 'max_output_tokens' &&
    continues < CONTINUE_RETRIES
  ) {
    continues++
    logger.debug(
      'response truncated (max_output_tokens), retrying (%d/%d)',
      continues,
      CONTINUE_RETRIES,
    )
    // Replay what the truncated turn produced before "Continue.", so the
    // retry is grounded in the partial answer (and any tool calls it already
    // emitted) instead of re-answering from scratch — the pattern the OpenAI
    // agents SDK uses for the same condition.
    pushResponseOutput(history, result.response)
    history.push({ role: 'user', content: 'Continue.' })
    result = await requestTurn()
  }
  return result
}

// Compact-and-retry after a context overflow. Returns the first request that
// succeeds; rethrows `original` when compaction can't free space (onOverflow
// returns false, or the circuit breaker has tripped) or the retries run out.
async function recoverFromOverflow(
  runOnce: () => Promise<TurnResult>,
  context: ContextManager,
  client: Client,
  config: Config,
  history: ResponseInput,
  original: unknown,
): Promise<TurnResult> {
  for (let retry = 0; retry < OVERFLOW_RETRIES; retry++) {
    if (!(await context.onOverflow(client, config, history))) break
    try {
      return await runOnce()
    } catch (err) {
      // Any non-overflow failure (or the ceiling of retries) propagates as
      // `original` below — except a non-overflow error is itself the more
      // useful one to surface.
      if (!isContextOverflowError(err)) throw err
    }
  }
  throw original
}

// Replay a turn's output into history for the next request. toResponseInputItems
// normalizes response.output into replayable items, INCLUDING reasoning items —
// which reasoning models (the GPT-5 family, o-series) require on every stateless
// turn (store: false, dcode's default against real OpenAI) that continues a tool
// call; a hand-rolled reconstruction that kept only function_call items silently
// dropped them. It does not strip `parsed_arguments` from function_call items,
// though (see stripParsedArguments), so that is mapped off explicitly.
function pushResponseOutput(
  history: ResponseInput,
  response: OpenAIResponse,
): void {
  history.push(
    ...toResponseInputItems(response.output ?? []).map(stripParsedArguments),
  )
}

function functionCalls(response: OpenAIResponse): ResponseFunctionToolCall[] {
  return (response.output ?? []).filter(
    (o): o is ResponseFunctionToolCall => o.type === 'function_call',
  )
}

function appendToolOutputs(
  history: ResponseInput,
  results: ToolResult[],
): void {
  for (const r of results) {
    history.push({
      type: 'function_call_output',
      call_id: r.id,
      output: r.output,
    })
  }
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
  // Called as each call settles (in completion order, which for a parallel
  // batch is not emission order), so the caller can render live progress.
  onResult?: (r: ToolResult) => void,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  let batch: [ResponseFunctionToolCall, ToolDefinition][] = []

  // A call that never reached a tool still needs an outcome, so the loop can
  // pair it with its function_call and keep history balanced.
  const didNotRun = (
    c: ResponseFunctionToolCall,
    output: string,
  ): ToolResult => ({ id: c.call_id, name: c.name, output, ok: false, ms: 0 })

  const runOne = async (
    c: ResponseFunctionToolCall,
    tool?: ToolDefinition,
  ): Promise<ToolResult> => {
    const outcome = await runOneOutcome(c, tool)
    onResult?.(outcome)
    return outcome
  }

  const runOneOutcome = (
    c: ResponseFunctionToolCall,
    tool?: ToolDefinition,
  ): Promise<ToolResult> => {
    if (ctx.signal?.aborted) return Promise.resolve(didNotRun(c, 'aborted'))
    if (!tool) {
      return Promise.resolve(didNotRun(c, `error: unknown tool "${c.name}"`))
    }
    return runTool(
      { id: c.call_id, name: c.name, arguments: c.arguments },
      tool,
      ctx,
    )
  }

  // Flush the accumulated parallel batch, preserving emission order.
  const flush = async () => {
    if (batch.length === 0) return
    const outs = await Promise.all(batch.map(([c, t]) => runOne(c, t)))
    results.push(...outs)
    batch = []
  }

  for (const c of calls) {
    // Resolve the tool once and hand it to the runner instead of looking it
    // up again inside runOneOutcome.
    const tool = registry.get(c.name)
    if (tool && tool.parallel !== false) {
      batch.push([c, tool])
    } else {
      await flush()
      results.push(await runOne(c, tool))
    }
  }
  await flush()
  return results
}
