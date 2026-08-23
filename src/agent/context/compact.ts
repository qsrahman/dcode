import type { Client, ResponseInput } from '../client.ts'
import type { AppConfig } from '../../config/schema.ts'
import type { Logger } from '../../util/log.ts'
import { estimateItem } from './tokens.ts'

const SUMMARY_CAP = 4096

const COMPACTION_INSTRUCTION = `You are condensing an earlier part of a coding session so it fits the model's context window. The conversation continues after this summary, so preserve everything needed to resume the work correctly.

Produce a structured summary with exactly these sections:
- Goal: what the user asked for and the overall objective.
- Constraints: rules, scope, and things the user explicitly forbade.
- Progress: what has been done so far and what is left.
- Key Decisions: non-obvious choices made and why.
- Next Steps: the immediate next action(s) to take.
- Critical Context: exact file paths touched, commands run, error messages and their fixes, and any pending tasks.

Be concise but retain concrete details (paths, command snippets, error text). Do not invent progress. Output only the summary — no preamble.`

// Keep the most recent `keepTokens` tokens of the (system-less) body, snapping
// the cut point backward to a `user` message so a tool-call group is never
// split: a `function_call` and its `function_call_output` must stay together,
// otherwise the Responses API rejects the request as an orphaned tool call.
function takeTail(
  body: ResponseInput,
  keepTokens: number,
): { tail: ResponseInput; summarized: number } {
  if (body.length === 0) return { tail: [], summarized: 0 }
  let kept = 0
  let start = body.length
  for (let i = body.length - 1; i >= 0; i--) {
    const tokens = estimateItem(body[i]!)
    if (kept + tokens > keepTokens && start < body.length) break
    kept += tokens
    start = i
  }
  while (start > 0) {
    const it = body[start] as { role?: string }
    if (it.role === 'user') break
    start--
  }
  return { tail: body.slice(start), summarized: start }
}

function serializeHistory(items: ResponseInput): string {
  const blocks: string[] = []
  for (const it of items) {
    const item = it as {
      type?: string
      role?: string
      name?: string
      call_id?: string
      content?: unknown
      arguments?: string
      output?: unknown
    }
    if (item.type === 'function_call') {
      blocks.push(
        `[assistant called ${item.name} (${item.call_id})]\n${item.arguments ?? ''}`,
      )
    } else if (item.type === 'function_call_output') {
      blocks.push(
        `[tool result ${item.call_id}]\n${typeof item.output === 'string' ? item.output : ''}`,
      )
    } else {
      const content =
        typeof item.content === 'string'
          ? item.content
          : JSON.stringify(item.content)
      blocks.push(`[${item.role ?? 'msg'}]\n${content}`)
    }
  }
  return blocks.join('\n\n')
}

// Summarize the oldest part of the conversation into a single developer message,
// retaining a recent tail verbatim. Returns the new history (system message +
// summary + tail). The summary is produced by a separate model call (tools
// disabled, capped output) and then discarded from the live request — only its
// text survives.
export async function compactHistory(
  client: Client,
  config: AppConfig,
  history: ResponseInput,
  logger: Logger,
): Promise<ResponseInput> {
  const system = history[0]!
  const body = history.slice(1)
  const keepTokens = config.context.keepTokens
  const { tail, summarized } = takeTail(body, keepTokens)
  const toSummarize = body.slice(0, summarized)
  if (toSummarize.length === 0) return history

  const summaryInput: ResponseInput = [
    {
      role: 'user',
      content: `${COMPACTION_INSTRUCTION}\n\n${serializeHistory(toSummarize)}`,
    },
  ]
  const stream = client.stream(summaryInput, { maxOutputTokens: SUMMARY_CAP })
  let summary = ''
  for await (const delta of stream) summary += delta
  await stream.finalResponse()
  const text = summary.trim() || '(no summary)'
  logger.debug('context compacted %d items into summary', toSummarize.length)
  return [system, { role: 'developer', content: text }, ...tail]
}
