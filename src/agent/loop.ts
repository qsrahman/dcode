import type { Client, ResponseInput } from './client.ts'
import type { AppConfig } from '../config/schema.ts'
import { resolveRoot } from '../config/config.ts'
import { buildSystemPrompt } from './system.ts'
import type { Logger } from '../util/log.ts'
import type { RunSink, StreamRef } from './run.ts'
import { runTurn, runTool } from './run.ts'
import type { ToolContext, ToolResult } from './types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { renderToolResult, renderToolOutput } from '../ui/render.ts'
import type { ResponseFunctionToolCall } from 'openai/resources/responses/responses'

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
  config: AppConfig,
  history: ResponseInput,
  opts: {
    sink?: RunSink
    logger: Logger
    signal?: AbortSignal
    tools?: ToolRegistry
    streamRef?: StreamRef
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
  let finalText = ''
  let prevHadTools = false

  for (let i = 0; i < config.maxToolIterations; i++) {
    // Every turn streams live to `sink`. A turn that follows a tool call gets a
    // leading blank line so its text is separated from the tool-output block.
    if (prevHadTools) sink.write('\n')
    const { text, response } = await runTurn(client, config, history, {
      sink,
      logger: opts.logger,
      tools: responses,
      streamRef: opts.streamRef,
    })
    finalText = text
    if (text.trim()) {
      history.push({
        role: 'assistant',
        content: text,
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
  config: AppConfig,
  prompt: string,
  opts: {
    sink?: RunSink
    logger: Logger
    tools?: ToolRegistry
    signal?: AbortSignal
    streamRef?: StreamRef
  },
): Promise<string> {
  const input: ResponseInput = [
    { role: 'system', content: buildSystemPrompt(config) },
    { role: 'user', content: prompt },
  ]
  return runAgent(client, config, input, opts)
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
