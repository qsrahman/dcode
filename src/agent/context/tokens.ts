import type { ResponseInput } from '../client.ts'

// Token estimation is deliberately cheap: a ~4-chars/token heuristic over the
// serialized request. The manager calibrates this heuristic against the real
// `usage.input_tokens` the provider returns, so the estimate tracks the model's
// actual tokenizer without pulling in a tokenizer dependency.

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function itemText(item: ResponseInput[number]): string {
  const it = item as {
    type?: string
    content?: unknown
    arguments?: string
    output?: unknown
  }
  if (it.type === 'function_call') return it.arguments ?? ''
  if (it.type === 'function_call_output') {
    return typeof it.output === 'string' ? it.output : ''
  }
  const content = it.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === 'string' ? p : ((p as { text?: string })?.text ?? ''),
      )
      .join('')
  }
  return ''
}

export function estimateItem(item: ResponseInput[number]): number {
  return estimateTokens(itemText(item))
}

export function estimateHistory(history: ResponseInput): number {
  let total = 0
  for (const item of history) total += estimateItem(item)
  return total
}
