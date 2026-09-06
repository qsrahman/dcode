import type { Client, OpenAIResponse, ResponseInput } from './client.ts'
import { isContextOverflowError } from './client.ts'
import type { Config } from '../config/schema.ts'
import { resolveRoot } from '../config/config.ts'
import { buildSystemPrompt } from './system.ts'
import type { Logger } from '../util/log.ts'
import type { RunSink } from './run.ts'
import { runTurn, runTool } from './run.ts'
import {
  renderToolResult,
  renderToolOutput,
  renderProgressLine,
  renderCategorySummary,
  newTally,
  tallyResult,
} from '../ui/tools.ts'

// Carriage return + erase-line: rewrites the current terminal line in place,
// used to update the live tool counter without scrolling. TTY-only (see use).
const CLEAR_LINE = '\r\x1b[2K'
import type { ToolContext, ToolResult } from './types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import { isCI } from '@clack/prompts'
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
    depth?: number
    instructions?: string
  },
): Promise<string> {
  const sink = opts.sink ?? process.stdout
  const registry = opts.tools ?? new ToolRegistry()
  const ctx: ToolContext = {
    root: resolveRoot(config),
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
  const instructions = opts.instructions ?? buildSystemPrompt(config)
  // Interactive default: one live tool counter for the whole query that
  // freezes into a single bounded category summary, above the streamed answer.
  // Piped output and --verbose keep the stable per-tool lines instead — a log
  // wants one record per call, and only a TTY can rewrite a line in place.
  // CI is excluded even when it presents a TTY: its captured log has no cursor,
  // so the in-place `\r\x1b[2K` redraws would land as literal escape noise.
  const live = Boolean(process.stdout.isTTY) && !isCI() && !config.verbose
  // The tally spans the whole query, accumulating across every tool turn, so a
  // multi-turn query collapses to one summary rather than one line per turn.
  let pending = newTally()
  const redraw = (current: string) => {
    sink.write(
      CLEAR_LINE +
        renderProgressLine(
          pending,
          current,
          Date.now() - pending.startedMs,
          config.color,
        ),
    )
  }
  // Freeze the accumulated tools into a summary and start a fresh tally. Called
  // just before the answer streams (via onBeforeText) and once more at the end
  // to catch a query that finishes on tools without any closing text.
  const freezeSummary = () => {
    if (!live || pending.done === 0) return
    // Trailing blank line separates the summary from the answer that streams
    // in beneath it (freezeSummary runs just before the first answer chunk).
    sink.write(
      `${CLEAR_LINE}  ${renderCategorySummary(pending, Date.now() - pending.startedMs, config.color)}\n\n`,
    )
    pending = newTally()
  }
  // One streaming turn; hoisted so the context-overflow retry reuses it instead
  // of duplicating the call.
  const runOnce = () =>
    runTurn(client, config, history, {
      sink,
      logger: opts.logger,
      tools: responses,
      instructions,
      signal: opts.signal,
      onBeforeText: freezeSummary,
    })
  let finalText = ''
  let prevHadTools = false
  const OVERFLOW_RETRIES = 3
  const CONTINUE_RETRIES = 3

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
    // Non-live only: separate a completed per-tool block from the next turn's
    // text with a blank line. In live mode the single tool line persists in
    // place across turns, so a newline here would strand it above the redraw.
    if (prevHadTools && !live) sink.write('\n')
    let response!: OpenAIResponse
    try {
      ;({ text: finalText, response } = await runOnce())
    } catch (err) {
      // The request exceeded the context window. Compact and retry up to
      // OVERFLOW_RETRIES times; if compaction doesn't help (or the breaker
      // trips), let it fail normally.
      if (opts.context && isContextOverflowError(err)) {
        let overflowOk = false
        for (let retry = 0; retry < OVERFLOW_RETRIES; retry++) {
          if (!(await opts.context.onOverflow(client, config, history))) break
          try {
            ;({ text: finalText, response } = await runOnce())
            overflowOk = true
            break
          } catch (retryErr) {
            if (
              !isContextOverflowError(retryErr) ||
              retry === OVERFLOW_RETRIES - 1
            )
              throw retryErr
          }
        }
        if (!overflowOk) throw err
      } else {
        throw err
      }
    }
    // A3: Max output tokens recovery — when the response is truncated, inject
    // a "Continue." prompt and retry the turn so the model can finish.
    let continueRetries = 0
    while (
      response.incomplete_details?.reason === 'max_output_tokens' &&
      continueRetries < CONTINUE_RETRIES
    ) {
      continueRetries++
      opts.logger.debug(
        'response truncated (max_output_tokens), retrying (%d/%d)',
        continueRetries,
        CONTINUE_RETRIES,
      )
      history.push({ role: 'user', content: 'Continue.' })
      ;({ text: finalText, response } = await runOnce())
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
    // Accumulate into the query-level tally; the live line redraws on each
    // completion (no timer). The summary is frozen later, once, by
    // freezeSummary — not per batch — so multi-turn queries stay one line.
    const results = await runCalls(calls, registry, ctx, (r) => {
      if (!live) return
      tallyResult(pending, r.name, r.ok)
      redraw(r.name)
    })
    for (const r of results) {
      history.push({
        type: 'function_call_output',
        call_id: r.id,
        output: r.output,
      })
      if (!live) {
        sink.write(`${renderToolResult(r.name, r.ok, r.ms, config.color)}\n`)
        if (config.verbose)
          sink.write(`${renderToolOutput(r.name, r.output, config.color)}\n`)
      }
    }
    // Abort only after every call has a recorded output, so history stays
    // balanced (no function_call without its function_call_output) and the
    // conversation can be resumed. handleLine catches this and logs `aborted`.
    // Freeze first so the tools that did run leave a clean summary behind.
    if (opts.signal?.aborted) {
      freezeSummary()
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
  freezeSummary()
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
  // Called as each call settles (in completion order, which for a parallel
  // batch is not emission order), so the caller can render live progress.
  onResult?: (r: ToolResult) => void,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  let batch: ResponseFunctionToolCall[] = []

  // A call that never reached a tool still needs an outcome, so the loop can
  // pair it with its function_call and keep history balanced.
  const didNotRun = (
    c: ResponseFunctionToolCall,
    output: string,
  ): ToolResult => ({ id: c.call_id, name: c.name, output, ok: false, ms: 0 })

  const runOne = async (c: ResponseFunctionToolCall): Promise<ToolResult> => {
    const outcome = await runOneOutcome(c)
    onResult?.(outcome)
    return outcome
  }

  const runOneOutcome = (c: ResponseFunctionToolCall): Promise<ToolResult> => {
    if (ctx.signal?.aborted) return Promise.resolve(didNotRun(c, 'aborted'))
    const tool = registry.get(c.name)
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
