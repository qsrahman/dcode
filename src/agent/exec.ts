import { errorMessage } from '../util/log.ts'
import type {
  ToolDefinition,
  ToolCall,
  ToolContext,
  ToolResult,
} from './types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { ResponseFunctionToolCall } from 'openai/resources/responses/responses'

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
  const outcome = (output: string, ok: boolean): ToolResult => ({
    id: call.id,
    name: tool.name,
    output: truncate(output, ctx.config.maxToolOutputBytes),
    ok,
    ms: Date.now() - start,
  })
  try {
    const raw = call.arguments ? JSON.parse(call.arguments) : {}
    const args = tool.parameters.parse(raw)
    const result = await withDeadline(
      tool.execute(args, ctx),
      ctx.config.toolTimeout,
      ctx.signal,
    )
    return outcome(result, true)
  } catch (err) {
    return outcome(`error: ${errorMessage(err)}`, false)
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

// Execute one turn's tool calls in the order the model emitted them. Parallel-
// eligible calls (read-only tools; `parallel !== false`) are batched via
// Promise.all; non-parallel calls (mutating tools) run one at a time in emission
// order. Every call yields exactly one outcome — an unknown-tool error, an
// `aborted` marker if the user cancelled before it ran, or the tool's real
// result — so history and rendering stay aligned and every function_call gets a
// function_call_output.
export async function runCalls(
  calls: ResponseFunctionToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  // Called as each call settles (in completion order, which for a parallel
  // batch is not emission order), so the caller can render live progress.
  onResult?: (r: ToolResult) => void,
): Promise<ToolResult[]> {
  // A call that never reached a tool still needs an outcome, so the caller
  // can pair it with its function_call and keep history balanced.
  const exec = async (
    c: ResponseFunctionToolCall,
    tool?: ToolDefinition,
  ): Promise<ToolResult> => {
    const result: ToolResult = ctx.signal?.aborted
      ? { id: c.call_id, name: c.name, output: 'aborted', ok: false, ms: 0 }
      : !tool
        ? {
            id: c.call_id,
            name: c.name,
            output: `error: unknown tool "${c.name}"`,
            ok: false,
            ms: 0,
          }
        : await runTool(
            { id: c.call_id, name: c.name, arguments: c.arguments },
            tool,
            ctx,
          )
    onResult?.(result)
    return result
  }

  const results: ToolResult[] = []
  let batch: Promise<ToolResult>[] = []
  // Flush the accumulated parallel batch, preserving emission order.
  const flush = async () => {
    results.push(...(await Promise.all(batch)))
    batch = []
  }

  for (const c of calls) {
    const tool = registry.get(c.name)
    if (tool && tool.parallel !== false) {
      batch.push(exec(c, tool))
    } else {
      await flush()
      results.push(await exec(c, tool))
    }
  }
  await flush()
  return results
}
