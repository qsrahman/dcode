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
  // Called once, immediately before the first visible chunk of this turn's
  // text reaches the sink. The agent loop uses it to freeze the accumulated
  // tool summary above the answer: intermediate reasoning turns emit no
  // visible text, so the first delta reliably marks the tool→answer
  // transition. Not called for a turn that streams nothing (a pure tool call).
  onBeforeText?: () => void
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
  const md = new MarkdownStreamRenderer(config.color)
  let announced = false
  // Fire onBeforeText exactly once, right before the first *visible* write —
  // not on every buffered delta that renders to nothing yet.
  const beforeVisible = () => {
    if (announced) return
    announced = true
    opts.onBeforeText?.()
  }
  const emit = (out: string) => {
    beforeVisible()
    sink.write(out)
  }
  for await (const delta of stream) {
    const out = md.push(delta)
    if (out) emit(out)
  }
  const response = await stream.finalResponse()
  const tail = md.finalize()
  if (tail) emit(tail)
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

// Race a tool's execution against its timeout and the caller's abort signal,
// rejecting promptly on whichever fires first. This has to be an actual
// `Promise.race`, not `await p` with the signals only consulted afterwards:
// a tool that neither observes ctx.signal nor bounds itself (a prompt
// waiting on stdin, a stalled socket) would otherwise hold the whole agent
// loop open forever, with `toolTimeout` never enforced against it.
//
// Losing the race abandons `p` rather than cancelling it — nothing here can
// force a tool to stop. That's why every process-spawning tool also receives
// ctx.signal (and its own `timeout`) directly: those kill the child for
// real, and this wrapper is the backstop for everything else. An abandoned
// `p` still needs a rejection handler attached, or its eventual failure
// surfaces as an unhandled rejection long after runTool returned.
async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(ms)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal
  // The timeout takes precedence in the message only when it's what fired;
  // an already-aborted caller signal still reads as 'aborted'.
  const deadlineError = () =>
    timeoutSignal.aborted && !signal?.aborted
      ? new Error(`tool timed out after ${ms}ms`)
      : new Error('aborted')

  // Marks `p` handled for the abandoned case above. Promise.race attaches
  // its own handlers independently, so this doesn't swallow a real rejection.
  void p.catch(() => {})

  if (combinedSignal.aborted) throw deadlineError()

  // Removes the abort listener once the race settles, so a fast tool doesn't
  // leave one attached to a caller signal that outlives it.
  const cleanup = new AbortController()
  const deadline = new Promise<never>((_resolve, reject) => {
    combinedSignal.addEventListener('abort', () => reject(deadlineError()), {
      once: true,
      signal: cleanup.signal,
    })
  })

  try {
    return await Promise.race([p, deadline])
  } catch (err) {
    // A tool that rejects *because* it saw the abort (execa's cancelSignal,
    // fetch's signal) reports its own low-level error; normalize those to
    // the same message the deadline branch produces.
    if (combinedSignal.aborted) throw deadlineError()
    throw err
  } finally {
    cleanup.abort()
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
