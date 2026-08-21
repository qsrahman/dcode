import type { Client, OpenAIResponse, ResponseInput } from './client.ts'
import type { AppConfig } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'
import { errorMessage } from '../util/log.ts'
import type {
  ToolDefinition,
  ToolCall,
  ToolContext,
  ToolResult,
} from './types.ts'
import type { Tool as ResponsesTool } from 'openai/resources/responses/responses'

export interface RunSink {
  write(text: string): void
}

// A RunSink that accumulates everything written instead of forwarding it —
// used to buffer output for later inspection or reordering (e.g. delaying a
// turn's text until it's known whether the turn was the final answer).
export class CapturingSink implements RunSink {
  text = ''
  write(s: string): void {
    this.text += s
  }
}

// Universal turn runner shared by one-shot and the REPL. Streams output to
// `sink` and forwards `signal` so callers (REPL) can abort an in-flight stream
// (decision L). Returns the SDK's own aggregated text (Response.output_text)
// plus the full response (for tool calls) — the delta loop below exists only
// to render output live, not to reconstruct the final text.
export async function runTurn(
  client: Client,
  config: AppConfig,
  input: ResponseInput,
  sink: RunSink = process.stdout,
  logger: Logger,
  signal?: AbortSignal,
  tools?: ResponsesTool[],
): Promise<{ text: string; response: OpenAIResponse }> {
  logger.debug('run turn model=%s', config.model)
  const stream = client.stream(input, { signal, tools })
  for await (const delta of stream) {
    sink.write(delta)
  }
  const response = await stream.finalResponse()
  if (response.output_text) sink.write('\n')
  return { text: response.output_text, response }
}

// Execute a single tool call with a per-tool timeout (decision: toolTimeout
// bounds execution) and output truncation (decision F). Tool failures are
// returned as outcomes, never thrown, so the loop can feed them back to the
// model (decision D).
export async function runTool(
  call: ToolCall,
  tool: ToolDefinition,
  ctx: ToolContext,
): Promise<ToolResult> {
  const start = Date.now()
  try {
    const raw = call.arguments ? JSON.parse(call.arguments) : {}
    const args = tool.parameters.parse(raw)
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
