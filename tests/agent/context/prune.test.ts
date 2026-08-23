import { describe, expect, it } from 'vitest'
import type { ResponseInput } from '../../../src/agent/client.ts'
import { pruneHistory } from '../../../src/agent/context/prune.ts'

function history(): ResponseInput {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
    {
      type: 'function_call_output',
      call_id: 'c1',
      output: 'OLD RESULT THAT IS LONG',
    },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
    { type: 'function_call', call_id: 'c2', name: 'read', arguments: '{}' },
    {
      type: 'function_call_output',
      call_id: 'c2',
      output: 'NEW RESULT THAT IS LONG',
    },
  ]
}

describe('pruneHistory', () => {
  it('collapses old tool outputs but keeps the most recent ones', () => {
    const h = history()
    const n = pruneHistory(h, { protectTurns: 1 })
    expect(n).toBe(1)
    const outputs = h.filter(
      (i) => (i as { type?: string }).type === 'function_call_output',
    ) as { output: string }[]
    // newest (c2) protected, oldest (c1) collapsed
    expect(outputs[0]!.output).toMatch(/\[output truncated\]/)
    expect(outputs[1]!.output).toBe('NEW RESULT THAT IS LONG')
  })

  it('protects more recent outputs when protectTurns is larger', () => {
    const h = history()
    const n = pruneHistory(h, { protectTurns: 5 })
    expect(n).toBe(0)
  })

  it('leaves short outputs and non-output items untouched', () => {
    const h = history()
    pruneHistory(h)
    expect((h[1] as { content: string }).content).toBe('first')
  })
})
