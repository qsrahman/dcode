import type { Client, ResponseInput } from './client.ts'
import type { AppConfig } from '../config/schema.ts'
import { resolveRoot } from '../config/config.ts'
import { buildSystemPrompt } from './system.ts'
import type { Logger } from '../util/log.ts'
import type { RunSink } from './run.ts'
import { runTurn, runTool } from './run.ts'
import type { ToolContext, ToolResult } from './types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { renderToolResult } from '../ui/render.ts'
import type { ResponseFunctionToolCall } from 'openai/resources/responses/responses'

// Agent loop: run turns, execute any tool calls the model makes, feed the
// results back, and repeat up to `maxToolIterations` (decision D). Text is
// streamed as it arrives; tool results are rendered between turns. Returns the
// final assistant text.
//
// Tool outputs are grouped into a single block (no blank line between them),
// with exactly one blank line separating that block from the final answer.
// Because the answer turn is only known to be final after it streams, post-tool
// turns are buffered and flushed (with a leading blank if they are the answer).
class CapturingSink implements RunSink {
  text = ''
  write(s: string): void {
    this.text += s
  }
}

export async function runAgent(
  client: Client,
  config: AppConfig,
  history: ResponseInput,
  opts: {
    sink?: RunSink
    logger: Logger
    signal?: AbortSignal
    tools?: ToolRegistry
  },
): Promise<string> {
  const sink = opts.sink ?? process.stdout
  const registry = opts.tools ?? new ToolRegistry()
  const ctx: ToolContext = {
    root: resolveRoot(config),
    config,
    logger: opts.logger,
  }
  const responses = registry.list().length
    ? registry.toResponsesTools()
    : undefined
  let finalText = ''
  let prevHadTools = false

  for (let i = 0; i < config.maxToolIterations; i++) {
    const target: RunSink = prevHadTools ? new CapturingSink() : sink
    const { text, response } = await runTurn(
      client,
      config,
      history,
      target,
      opts.logger,
      opts.signal,
      responses,
    )
    finalText = text
    if (text.trim()) {
      history.push({
        role: 'assistant',
        content: text,
      } as ResponseInput[number])
    }
    const calls = (response.output ?? []).filter(
      (o): o is ResponseFunctionToolCall => o.type === 'function_call',
    )
    for (const c of calls) history.push(c as ResponseInput[number])
    if (calls.length === 0) {
      if (prevHadTools) {
        sink.write('\n')
        sink.write((target as CapturingSink).text)
      }
      break
    }
    if (prevHadTools) sink.write((target as CapturingSink).text)
    prevHadTools = true
    const results = await Promise.all(
      calls.map(async (c): Promise<{ id: string; outcome: ToolResult }> => {
        const tool = registry.get(c.name)
        const outcome = tool
          ? await runTool(
              { id: c.call_id, name: c.name, arguments: c.arguments },
              tool,
              ctx,
            )
          : {
              id: c.call_id,
              name: c.name,
              output: `error: unknown tool "${c.name}"`,
              ok: false,
              ms: 0,
            }
        return { id: c.call_id, outcome }
      }),
    )
    for (const { id, outcome } of results) {
      history.push({
        type: 'function_call_output',
        call_id: id,
        output: outcome.output,
      } as ResponseInput[number])
      sink.write(`${renderToolResult(outcome.name, outcome.ok, outcome.ms)}\n`)
      if (config.verbose) sink.write(`${outcome.output}\n`)
    }
  }
  return finalText
}

// One-shot orchestration: a single user turn through the agent loop. Builds the
// input (system + user) and delegates to runAgent. Returns the final text.
export async function runOneShot(
  client: Client,
  config: AppConfig,
  prompt: string,
  sink: RunSink = process.stdout,
  logger: Logger,
  tools: ToolRegistry = new ToolRegistry(),
): Promise<string> {
  const input: ResponseInput = [
    { role: 'system', content: buildSystemPrompt(config) },
    { role: 'user', content: prompt },
  ]
  return runAgent(client, config, input, { sink, logger, tools })
}
