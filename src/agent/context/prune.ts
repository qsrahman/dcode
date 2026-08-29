import type { ResponseInput } from '../client.ts'

export interface PruneOpts {
  // How many of the most recent tool-call *turns* to keep verbatim — all
  // outputs from a turn together, not just the last N individual outputs
  // (a turn that made several parallel calls has several outputs). Older
  // turns' outputs are collapsed to a marker so the model still sees it
  // called a tool, just not the (often bulky) result.
  protectTurns?: number
  marker?: string
}

// A turn's function_call_output items are always pushed as one consecutive
// block (see loop.ts: all of a turn's outputs are appended in emission
// order, immediately after each other, before the next turn's items start),
// so a maximal run of adjacent indices in `positions` is exactly one turn's
// outputs. Grouping this way — rather than just taking positions in
// isolation — is what lets "protect the last N turns" actually protect a
// turn's outputs as a unit.
function groupIntoRuns(positions: number[]): number[][] {
  const runs: number[][] = []
  for (const pos of positions) {
    const current = runs.at(-1)
    if (current && pos === current.at(-1)! + 1) {
      current.push(pos)
    } else {
      runs.push([pos])
    }
  }
  return runs
}

// Cheap, lossy size reduction with no model call: replace old
// `function_call_output` payloads with a short marker. The most recent
// `protectTurns` turns' outputs are left intact so the model keeps what it
// likely still needs. Returns the number of outputs collapsed.
export function pruneHistory(
  history: ResponseInput,
  opts: PruneOpts = {},
): number {
  const protectTurns = opts.protectTurns ?? 2
  const marker = opts.marker ?? '[output truncated]'
  const outputPositions: number[] = []
  for (let i = 0; i < history.length; i++) {
    const it = history[i] as { type?: string }
    if (it.type === 'function_call_output') outputPositions.push(i)
  }
  const runs = groupIntoRuns(outputPositions)
  // `runs.slice(-0)` behaves like `slice(0)` (the whole array) in JS, not
  // "slice nothing" — guard protectTurns <= 0 explicitly rather than relying
  // on negative-slice semantics to do the right thing at the boundary.
  const protectedRuns = protectTurns > 0 ? runs.slice(-protectTurns) : []
  const protectedSet = new Set(protectedRuns.flat())
  let pruned = 0
  for (let i = 0; i < history.length; i++) {
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
