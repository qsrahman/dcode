import type { Client, OpenAIResponse, ResponseInput } from './client.ts'
import { isContextOverflowError } from './client.ts'
import type { Config } from '../config/schema.ts'
import { buildSystemPrompt } from './system.ts'
import type { Logger } from '../util/log.ts'
import type { RunSink } from '../ui/sink.ts'
import { runTurn } from './turn.ts'
import { runCalls } from './exec.ts'
import { createToolProgress } from '../ui/tools.ts'
import type { ToolContext, ToolResult } from './types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import { ContextManager } from './context/manager.ts'

export interface AgentResult {
  text: string
  // True when the loop stopped because it hit `maxToolIterations` with tool
  // calls still pending — not because the model finished on its own. history
  // is left fully resumable either way: every iteration's tool calls are
  // paired with their outputs (appendToolOutputs) *before* the cap is
  // checked, so nothing is left dangling. A caller can raise
  // `maxToolIterations` (e.g. `/limit`) and call runAgent again with the same
  // history to continue — the model will see everything it already did and
  // pick up from there, the same way it continues between any two ordinary
  // iterations of this same loop. (No dedicated resume affordance exists yet
  // — see cli/commands.ts's `/limit` — a `/continue` command that resumes
  // without requiring a throwaway follow-up prompt is a natural next step.)
  truncated: boolean
  // Token usage from the *final* turn's response, when the provider reported
  // it (real OpenAI always does; some OpenAI-compatible endpoints omit
  // `usage` entirely — hence optional). Surfaced so a caller displaying
  // per-turn stats (the REPL's status line) doesn't have to plumb the whole
  // Response through itself; a multi-iteration tool-calling exchange only
  // ever needs the last turn's numbers, not a running sum of every retry.
  inputTokens?: number
  outputTokens?: number
}

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
): Promise<AgentResult> {
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
  const runOnce = (): Promise<OpenAIResponse> =>
    runTurn(client, config, history, {
      sink,
      logger: opts.logger,
      tools: responses,
      instructions,
      signal: opts.signal,
      onBeforeText: progress.freeze,
    })

  let last: OpenAIResponse | undefined
  let truncated = false

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
    // Every iteration after the first exists only because the previous turn
    // made tool calls (a call-free turn breaks out below).
    progress.separate(i > 0)

    const response = await completeTurn({
      runOnce,
      context: opts.context,
      client,
      config,
      history,
      logger: opts.logger,
    })
    last = response
    // Recalibrate the token estimate against the provider's real usage.
    opts.context?.observe(response.usage, history)
    pushResponseOutput(history, response)

    const calls = functionCalls(response)
    if (calls.length === 0) break

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
      truncated = true
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
  return {
    text: last?.output_text ?? '',
    truncated,
    inputTokens: last?.usage?.input_tokens,
    outputTokens: last?.usage?.output_tokens,
  }
}

// Run one streaming turn, recovering from two provider-side conditions before
// returning: a context overflow (compact and retry) and a truncated response
// (max_output_tokens — inject "Continue." and retry so the model can finish).
// Both are bounded so a pathological turn can't retry forever.
async function completeTurn(deps: {
  runOnce: () => Promise<OpenAIResponse>
  context?: ContextManager
  client: Client
  config: Config
  history: ResponseInput
  logger: Logger
}): Promise<OpenAIResponse> {
  const { runOnce, context, client, config, history, logger } = deps

  // One request attempt, with an overflow routed into compact-and-retry. Used
  // for the initial request and every "Continue." retry alike, so a retry that
  // itself overflows is recovered rather than surfacing raw. Rethrows the
  // original overflow when compaction can't free space (onOverflow returns
  // false, or its circuit breaker has tripped) or the retries run out; a
  // non-overflow failure on a retry is itself the more useful error to surface.
  const requestTurn = async (): Promise<OpenAIResponse> => {
    try {
      return await runOnce()
    } catch (err) {
      if (!(context && isContextOverflowError(err))) throw err
      for (let retry = 0; retry < OVERFLOW_RETRIES; retry++) {
        if (!(await context.onOverflow(client, config, history))) break
        try {
          return await runOnce()
        } catch (retryErr) {
          if (!isContextOverflowError(retryErr)) throw retryErr
        }
      }
      throw err
    }
  }

  let response = await requestTurn()
  for (
    let n = 1;
    n <= CONTINUE_RETRIES &&
    response.incomplete_details?.reason === 'max_output_tokens';
    n++
  ) {
    logger.debug(
      'response truncated (max_output_tokens), retrying (%d/%d)',
      n,
      CONTINUE_RETRIES,
    )
    // Replay what the truncated turn produced before "Continue.", so the
    // retry is grounded in the partial answer instead of re-answering from
    // scratch — the pattern the OpenAI agents SDK uses for the same
    // condition. Tool calls are excluded: a `function_call` cut off by the
    // same truncation is never executed (only the final response's calls
    // are, in `runAgent`), and replaying it would leave a `function_call`
    // in history with no matching `function_call_output` — the Responses
    // API rejects that unbalanced pairing on the very next request.
    pushResponseOutput(history, response, { skipToolCalls: true })
    history.push({ role: 'user', content: 'Continue.' })
    response = await requestTurn()
  }
  return response
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
  opts: { skipToolCalls?: boolean } = {},
): void {
  const items = toResponseInputItems(response.output ?? []).map(
    stripParsedArguments,
  )
  history.push(
    ...(opts.skipToolCalls
      ? items.filter((item) => item.type !== 'function_call')
      : items),
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

// One-shot orchestration: a single user turn through the agent loop. Wraps the
// prompt as the sole history item (the system prompt travels separately, as
// `instructions`) and delegates to runAgent.
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
): Promise<AgentResult> {
  const context = new ContextManager(config.context, opts.logger)
  const input: ResponseInput = [{ role: 'user', content: prompt }]
  return runAgent(client, config, input, { ...opts, context })
}
