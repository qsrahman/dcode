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

  // Regression: protectTurns names a count of *turns*, but the previous
  // implementation protected the last N individual output positions. A
  // recent turn with several parallel tool calls has several outputs
  // pushed as one consecutive block (see loop.ts) — protecting only "the
  // last N outputs" could protect part of that turn and prune the rest,
  // even though they're all equally recent.
  it('protects every output from the most recent turn, not just the last N individually', () => {
    const h: ResponseInput = [
      { role: 'user', content: 'first' },
      { type: 'function_call', call_id: 'old', name: 'read', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'old',
        output: 'OLD RESULT THAT IS LONG',
      },
      { role: 'user', content: 'second' },
      // A single turn making three parallel tool calls: three outputs
      // pushed consecutively, with no other item in between.
      { type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'read', arguments: '{}' },
      { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'a',
        output: 'RESULT A THAT IS LONG',
      },
      {
        type: 'function_call_output',
        call_id: 'b',
        output: 'RESULT B THAT IS LONG',
      },
      {
        type: 'function_call_output',
        call_id: 'c',
        output: 'RESULT C THAT IS LONG',
      },
    ]
    const n = pruneHistory(h, { protectTurns: 1 })
    // Only the older, separate turn's output is collapsed.
    expect(n).toBe(1)
    const outputs = h.filter(
      (i) => (i as { type?: string }).type === 'function_call_output',
    ) as { call_id: string; output: string }[]
    expect(outputs.find((o) => o.call_id === 'old')!.output).toMatch(
      /\[output truncated\]/,
    )
    expect(outputs.find((o) => o.call_id === 'a')!.output).toBe(
      'RESULT A THAT IS LONG',
    )
    expect(outputs.find((o) => o.call_id === 'b')!.output).toBe(
      'RESULT B THAT IS LONG',
    )
    expect(outputs.find((o) => o.call_id === 'c')!.output).toBe(
      'RESULT C THAT IS LONG',
    )
  })

  it('protects nothing when protectTurns is 0', () => {
    const h = history()
    const n = pruneHistory(h, { protectTurns: 0 })
    expect(n).toBe(2)
  })
})
