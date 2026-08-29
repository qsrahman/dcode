import type { Client, OpenAIResponse, ResponseInput } from './client.ts'
import type { Config } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'
import { errorMessage } from '../util/log.ts'
import type {
  ToolDefinition,
  ToolCall,
  ToolContext,
  ToolResult,
} from './types.ts'
import type { Tool as ResponsesTool } from 'openai/resources/responses/responses'
import { MarkdownStreamRenderer } from '../ui/markdown.ts'

export interface RunSink {
  write(text: string): void
}

// A RunSink that accumulates everything written instead of forwarding it —
// used by scripts/live-stress.ts to capture a turn's rendered output for
// UI-spacing assertions without printing it live.
export class CapturingSink implements RunSink {
  text = ''
  write(s: string): void {
    this.text += s
  }
}

export interface TurnOpts {
  sink?: RunSink
  logger: Logger
  tools?: ResponsesTool[]
  instructions?: string
  signal?: AbortSignal
}

// Universal turn runner shared by one-shot and the REPL. Streams output to
// `sink`; the model request is cancellable via `opts.signal`, which is passed
// straight into the SDK's own request-level abort support (decision L).
// Returns the SDK's own aggregated text (Response.output_text) plus the full
// response (for tool calls) — `response.output_text` is the SDK's own
// aggregated text, not reconstructed from the deltas. Deltas are rendered as
// markdown live via MarkdownStreamRenderer, which only emits block-complete
// lines (see ui/markdown.ts) so a client never sees broken mid-render
// markdown (an unclosed `**`, a code fence rendered before it closes).
export async function runTurn(
  client: Client,
  config: Config,
  input: ResponseInput,
  opts: TurnOpts,
): Promise<{ text: string; response: OpenAIResponse }> {
  const { logger, tools } = opts
  const sink = opts.sink ?? process.stdout
  logger.debug('run turn model=%s', config.model)
  const stream = client.stream(input, {
    tools,
    instructions: opts.instructions,
    signal: opts.signal,
  })
  const md = new MarkdownStreamRenderer()
  for await (const delta of stream) {
    const out = md.push(delta)
    if (out) sink.write(out)
  }
  const response = await stream.finalResponse()
  const tail = md.finalize()
  if (tail) sink.write(tail)
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
async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(ms)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal

  try {
    return await p
  } catch (err) {
    if (combinedSignal.aborted) {
      if (timeoutSignal.aborted) {
        throw new Error(`tool timed out after ${ms}ms`)
      }
      throw new Error('aborted')
    }
    throw err
  }
}

function truncate(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s)
  if (bytes.length <= maxBytes) return s
  let end = maxBytes
  // end is < bytes.length because we returned early if bytes.length <= maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--
  }
  const cut = new TextDecoder().decode(bytes.subarray(0, end))
  return `${cut}\n… [output truncated to ${maxBytes} bytes]`
}
