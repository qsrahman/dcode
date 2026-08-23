import { describe, expect, it } from 'vitest'
import {
  estimateTokens,
  estimateItem,
  estimateHistory,
} from '../../../src/agent/context/tokens.ts'

describe('estimateTokens', () => {
  it('uses a ~4 chars/token heuristic', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('estimateItem / estimateHistory', () => {
  it('estimates message content and tool items', () => {
    const history = [
      { role: 'system', content: 'abcd' },
      { role: 'user', content: 'abcdefgh' },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'x'.repeat(40) },
    ] as const
    expect(estimateItem(history[0])).toBe(1)
    expect(estimateItem(history[1])).toBe(2)
    // 40 chars -> 10 tokens
    expect(estimateItem(history[3])).toBe(10)
    expect(estimateHistory(history as never)).toBe(1 + 2 + 1 + 10)
  })
})
