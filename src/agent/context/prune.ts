import type { ResponseInput } from '../client.ts'

export interface PruneOpts {
  // How many of the most recent tool-call results to keep verbatim. Older
  // outputs are collapsed to a marker so the model still sees it called a tool,
  // just not the (often bulky) result.
  protectTurns?: number
  marker?: string
}

// Cheap, lossy size reduction with no model call: replace old
// `function_call_output` payloads with a short marker. The most recent
// `protectTurns` outputs are left intact so the model keeps what it likely still
// needs. Returns the number of outputs collapsed.
export function pruneHistory(
  history: ResponseInput,
  opts: PruneOpts = {},
): number {
  const protectTurns = opts.protectTurns ?? 2
  const marker = opts.marker ?? '[output truncated]'
  const outputPositions: number[] = []
  for (let i = 1; i < history.length; i++) {
    const it = history[i] as { type?: string }
    if (it.type === 'function_call_output') outputPositions.push(i)
  }
  const protectCount = Math.min(protectTurns, outputPositions.length)
  const protectedSet = new Set(
    outputPositions.slice(outputPositions.length - protectCount),
  )
  let pruned = 0
  for (let i = 1; i < history.length; i++) {
    if (protectedSet.has(i)) continue
    const it = history[i] as { type?: string; output?: unknown }
    if (it.type === 'function_call_output' && typeof it.output === 'string') {
      const n = it.output.length
      if (n > marker.length) {
        it.output = `${marker} (${n} chars)`
        pruned++
      }
    }
  }
  return pruned
}
