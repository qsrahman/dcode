import type { Client, OpenAIResponse, ResponseInput } from './client.ts'
import type { AppConfig } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'
import { errorMessage } from '../util/log.ts'
import type { Tool, ToolCall, ToolContext, ToolResult } from './types.ts'
import type { Tool as ResponsesTool } from 'openai/resources/responses/responses'

export interface RunSink {
  write(text: string): void
}

export interface RunTurnResult {
  text: string
  response: OpenAIResponse
}

// Universal turn runner shared by one-shot and the REPL. Streams output to
// `sink` and forwards `signal` so callers (REPL) can abort an in-flight stream
// (decision L). Returns the full text plus the SDK response (for tool calls).
export async function runTurn(
  client: Client,
  config: AppConfig,
  input: ResponseInput,
  sink: RunSink = process.stdout,
  logger: Logger,
  signal?: AbortSignal,
  tools?: ResponsesTool[],
): Promise<RunTurnResult> {
  logger.debug('run turn model=%s', config.model)
  let full = ''
  const stream = client.stream(input, { signal, tools })
  for await (const delta of stream) {
    full += delta
    sink.write(delta)
  }
  if (full) sink.write('\n')
  const response = await stream.finalResponse()
  return { text: full, response }
}

// Execute a single tool call with a per-tool timeout (decision: toolTimeout
// gates execution) and output truncation (decision F). Tool failures are
// returned as outcomes, never thrown, so the loop can feed them back to the
// model (decision D).
export async function runTool(
  call: ToolCall,
  tool: Tool,
  ctx: ToolContext,
): Promise<ToolResult> {
  const start = Date.now()
  try {
    const args = call.arguments ? JSON.parse(call.arguments) : {}
    const result = await withTimeout(
      tool.execute(args, ctx),
      ctx.config.toolTimeout,
    )
    return {
      id: call.id,
      name: tool.name,
      output: truncate(result, ctx.config.maxToolOutputBytes),
      ok: true,
      ms: Date.now() - start,
    }
  } catch (err) {
    return {
      id: call.id,
      name: tool.name,
      output: truncate(
        `error: ${errorMessage(err)}`,
        ctx.config.maxToolOutputBytes,
      ),
      ok: false,
      ms: Date.now() - start,
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`tool timed out after ${ms}ms`)),
      ms,
    )
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function truncate(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s)
  if (bytes.length <= maxBytes) return s
  const cut = new TextDecoder().decode(bytes.subarray(0, maxBytes))
  return `${cut}\n… [output truncated to ${maxBytes} bytes]`
}
