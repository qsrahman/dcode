import type { ToolContext } from '../../agent/types.ts'

// Shared network boundary for the web tools. Deliberately thin: it bounds the
// request lifetime and caps how much is read, but does NOT filter the target
// host. web_fetch reaches whatever address the URL resolves to — loopback,
// LAN, and cloud-metadata endpoints included — matching opencode's model,
// where network containment is the surrounding sandbox's job, not the tool's.
// dcode already hands the model a full shell (run_shell/run_process), so the
// trust boundary is "don't point dcode at untrusted input", not this tool.

// Bounds the request with ctx.config.toolTimeout (combined with ctx.signal via
// AbortSignal.any) so a hung request is actually cancelled rather than left
// running after runTool gives up on it — the same resource-cancellation
// discipline tools/local/exec.ts's execa calls already have. Redirects follow
// natively; global fetch only follows http(s) hops and caps them itself.
export async function fetchSafely(
  url: URL,
  init: RequestInit,
  ctx: ToolContext,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(ctx.config.toolTimeout)
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, timeoutSignal])
    : timeoutSignal
  return fetch(url, { ...init, signal })
}

// Cap how much of a response body is read into memory. Reads the stream
// directly rather than res.text() so an oversized body is cut off during
// download instead of buffered in full before being discarded.
export async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) return { text: await res.text(), truncated: false }
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.length - (total - maxBytes)))
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return { text, truncated }
}
