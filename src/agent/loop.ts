import type { Client, OpenAIResponse, ResponseInput } from './client.ts'
import { isContextOverflowError } from './client.ts'
import type { Config } from '../config/schema.ts'
import { resolveRoot } from '../config/config.ts'
import { buildSystemPrompt } from './system.ts'
import type { Logger } from '../util/log.ts'
import type { RunSink, StreamRef } from './run.ts'
import { runTurn, runTool } from './run.ts'
import type { ToolContext, ToolResult } from './types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import ansis from 'ansis'
import type { ResponseFunctionToolCall } from 'openai/resources/responses/responses'
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
    streamRef?: StreamRef
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
      streamRef: opts.streamRef,
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
    if (finalText.trim()) {
      history.push({
        role: 'assistant',
        content: finalText,
      })
    }
    const calls = (response.output ?? []).filter(
      (o): o is ResponseFunctionToolCall => o.type === 'function_call',
    )
    for (const c of calls) history.push(c)
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
    streamRef?: StreamRef
  },
): Promise<string> {
  const context = new ContextManager(config.context, opts.logger)
  const input: ResponseInput = [{ role: 'user', content: prompt }]
  return runAgent(client, config, input, { ...opts, context })
}

// Execute one turn's tool calls in the order the model emitted them. Every call
// yields exactly one outcome — an unknown-tool error, an `aborted` marker if the
// user cancelled before it ran, or the tool's real result — so history and
// rendering stay aligned and every function_call gets a function_call_output.
async function runCalls(
  calls: ResponseFunctionToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<{ id: string; outcome: ToolResult }[]> {
  const results: { id: string; outcome: ToolResult }[] = []
  for (const c of calls) {
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
    results.push({ id: c.call_id, outcome })
  }
  return results
}

export function renderToolResult(
  name: string,
  ok: boolean,
  ms: number,
): string {
  const status = ok ? ansis.green('✓') : ansis.red('✗')
  const secs = (ms / 1000).toFixed(1)
  return `› ${name}: ${status} ${ok ? 'done' : 'failed'} (${secs}s)`
}

const RULE = '─'.repeat(40)

// Verbose mode echoes a tool's raw output between turns; dim fences mark it
// as diagnostics so it doesn't read as more streamed model text.
export function renderToolOutput(name: string, output: string): string {
  return [ansis.dim(`── ${name} output ${RULE}`), output, ansis.dim(RULE)].join(
    '\n',
  )
}
