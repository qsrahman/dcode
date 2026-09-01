import type { ResponseInput } from '../client.ts'
import type { ResponseItemFields } from '../types.ts'

// Token estimation is deliberately cheap: a ~4-chars/token heuristic over the
// serialized request. The manager calibrates this heuristic against the real
// `usage.input_tokens` the provider returns, so the estimate tracks the model's
// actual tokenizer without pulling in a tokenizer dependency.

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// Extract the text of a message item's `content` field: a plain string, or
// an array of content parts (only the `text` of a `{type, text}`-shaped part
// carries meaningful text — other part types, e.g. images, contribute
// nothing extractable). Anything else (an unexpected shape, not string or
// array) falls back to JSON.stringify rather than '' — a silent empty
// string would make estimateItem undercount the item's real size instead of
// just estimating it roughly. Exported so compact.ts's serializeHistory (the
// compaction transcript) reads `content` the same way the token estimator
// does, rather than each maintaining its own slightly different extraction
// that could quietly drift apart.
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === 'string' ? p : ((p as { text?: string })?.text ?? ''),
      )
      .join('')
  }
  return content === undefined ? '' : JSON.stringify(content)
}

function itemText(item: ResponseInput[number]): string {
  const it = item as ResponseItemFields
  if (it.type === 'function_call') return it.arguments ?? ''
  if (it.type === 'function_call_output') {
    return typeof it.output === 'string' ? it.output : ''
  }
  return contentToText(it.content)
}

export function estimateItem(item: ResponseInput[number]): number {
  return estimateTokens(itemText(item))
}

export function estimateHistory(history: ResponseInput): number {
  let total = 0
  for (const item of history) total += estimateItem(item)
  return total
}
