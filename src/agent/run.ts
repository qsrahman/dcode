import type {
  Client,
  ModelStream,
  OpenAIResponse,
  ResponseInput,
} from './client.ts'
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

export type StreamRef = { current: ModelStream | null }

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
// `sink`; the model request is cancellable via the SDK-native stream abort
// (callers set `streamRef.current` and invoke `abort()` on Ctrl-C, decision L).
// Returns the SDK's own aggregated text (Response.output_text) plus the full
// response (for tool calls) — the delta loop below exists only to render output
// live, not to reconstruct the final text.
export async function runTurn(
  client: Client,
  config: AppConfig,
  input: ResponseInput,
  sink: RunSink = process.stdout,
  logger: Logger,
  tools?: ResponsesTool[],
  streamRef?: StreamRef,
): Promise<{ text: string; response: OpenAIResponse }> {
  logger.debug('run turn model=%s', config.model)
  const stream = client.stream(input, { tools })
  if (streamRef) streamRef.current = stream
  for await (const delta of stream) {
    sink.write(delta)
  }
  const response = await stream.finalResponse()
  if (response.output_text) sink.write('\n')
  return { text: response.output_text, response }
}

// Execute a single tool call with a per-tool timeout (decision: toolTimeout
// bounds execution), abort support (Ctrl-C via ctx.signal), and output
// truncation (decision F). Tool failures — including a timeout or abort — are
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
    const result = await withDeadline(
      tool.execute(args, ctx),
      ctx.config.toolTimeout,
      ctx.signal,
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

// Race a tool's execution against its timeout and the caller's abort signal.
// Rejects promptly on either; the tool promise still settles (its rejection is
// handled here, so no unhandled rejection). Process-spawning tools also receive
// ctx.signal directly, so the abort actually kills the child, not just this
// wrapper.
function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    let done = false
    let timer: ReturnType<typeof setTimeout>
    function finish(settle: () => void): void {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    function onAbort(): void {
      finish(() => reject(new Error('aborted')))
    }
    timer = setTimeout(
      () => finish(() => reject(new Error(`tool timed out after ${ms}ms`))),
      ms,
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    )
  })
}

function truncate(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s)
  if (bytes.length <= maxBytes) return s
  const cut = new TextDecoder().decode(bytes.subarray(0, maxBytes))
  return `${cut}\n… [output truncated to ${maxBytes} bytes]`
}
