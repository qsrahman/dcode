import { describe, expect, it } from 'vitest'
import {
  estimateTokens,
  estimateItem,
  estimateHistory,
  contentToText,
} from '../../../src/agent/context/tokens.ts'

describe('estimateTokens', () => {
  it('uses a ~4 chars/token heuristic', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('contentToText', () => {
  it('passes a plain string through', () => {
    expect(contentToText('hello')).toBe('hello')
  })

  it('joins the text of content parts shaped like {type, text}', () => {
    expect(
      contentToText([
        { type: 'output_text', text: 'part one' },
        { type: 'output_text', text: ' part two' },
      ]),
    ).toBe('part one part two')
  })

  it('contributes nothing for a part with no text field (e.g. an image)', () => {
    expect(contentToText([{ type: 'input_image', image_url: 'x' }])).toBe('')
  })

  it('falls back to empty for undefined (no content at all)', () => {
    expect(contentToText(undefined)).toBe('')
  })

  // Regression: the old itemText silently returned '' for any shape that
  // wasn't a string or an array, undercounting the item's real size in the
  // token estimate instead of estimating it roughly.
  it('falls back to JSON.stringify for an unexpected shape, not an empty string', () => {
    const out = contentToText({ weird: 'shape' })
    expect(out).not.toBe('')
    expect(out).toContain('weird')
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
