import type { Client, ResponseInput } from '../client.ts'
import type { Config } from '../../config/schema.ts'
import type { Logger } from '../../util/log.ts'
import { errorMessage } from '../../util/log.ts'
import type { Task } from '../tasks.ts'
import { estimateItem } from './tokens.ts'

const SUMMARY_CAP = 4096

// The summarization request is sent as a `user` input message (not `developer`
// /`system`): several OpenAI-compatible / local endpoints don't accept those
// roles as input and return a non-conformant `output` shape the SDK can't
// parse. `user` is universally supported, and the same role is used for the
// injected summary message.
const SUMMARY_ROLE = 'user' as const

const COMPACTION_INSTRUCTION = `You are condensing an earlier part of a coding session so it fits the model's context window. The conversation continues after this summary, so preserve everything needed to resume the work correctly.

Produce a structured summary with exactly these sections:
- Goal: what the user asked for and the overall objective.
- Constraints: rules, scope, and things the user explicitly forbade.
- Progress: what has been done so far and what is left.
- Key Decisions: non-obvious choices made and why.
- Next Steps: the immediate next action(s) to take.
- Critical Context: exact file paths touched, commands run, error messages and their fixes, and any pending tasks.

Be concise but retain concrete details (paths, command snippets, error text). Do not invent progress. Output only the summary — no preamble.`

// Keep the most recent history up to `keepTokens` tokens, always retaining at
// least the final item (a single item can't be split). The cut point is then
// snapped backward to a `user` message so a tool-call group is never split: a
// `function_call` and its `function_call_output` must stay together, otherwise
// the Responses API rejects the request as an orphaned tool call.
function takeTail(
  body: ResponseInput,
  keepTokens: number,
): { tail: ResponseInput; summarized: number } {
  if (body.length === 0) return { tail: [], summarized: 0 }
  let start = body.length - 1
  let kept = estimateItem(body[start]!)
  for (let i = body.length - 2; i >= 0; i--) {
    const tokens = estimateItem(body[i]!)
    if (kept + tokens > keepTokens) break
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

// Generate the summary via a separate model call (no tools, capped output).
async function summarize(
  client: Client,
  instruction: string,
  logger: Logger,
): Promise<string> {
  const input: ResponseInput = [{ role: SUMMARY_ROLE, content: instruction }]
  const stream = client.stream(input, { maxOutputTokens: SUMMARY_CAP })
  let summary = ''
  for await (const delta of stream) summary += delta
  // Some OpenAI-compatible / local endpoints stream valid summary text but
  // return a non-conformant `output` shape that finalResponse() can't parse.
  // The summary is the streamed deltas, so keep them instead of crashing.
  try {
    await stream.finalResponse()
  } catch (err) {
    if (!summary.trim()) throw err
    logger.debug('compaction finalize skipped (%s)', errorMessage(err))
  }
  return summary.trim() || '(no summary)'
}

// Render the authoritative task list into the compaction instruction so the
// summary can't drift from or contradict what the model actually tracked. The
// list comes from the session's TaskStore (not from conversation text), so it is
// the source of truth for outstanding work.
function formatTasks(tasks: Task[]): string {
  const lines = tasks.map((t) => {
    const blocked = t.blockedBy.length
      ? ` (blocked by ${t.blockedBy.join(', ')})`
      : ''
    return `- [${t.status}] ${t.id} ${t.title}${blocked}`
  })
  return `\n\nAuthoritative task list (source of truth — preserve each task's status; do not invent or contradict it):\n${lines.join('\n')}`
}

// Summarize the oldest part of the conversation into a single message, retaining
// a recent tail verbatim. Returns the new history (summary + tail). The summary
// is produced by a separate model call (tools disabled, capped output) and then
// discarded from the live request — only its text survives. The durable system
// prompt is carried separately via the Responses API `instructions` field, so it
// is not part of `history` and is not re-injected here. `tasks`, when supplied,
// is the session's current task list, appended so the summary stays consistent.
export async function compactHistory(
  client: Client,
  config: Config,
  history: ResponseInput,
  logger: Logger,
  tasks?: Task[],
): Promise<ResponseInput> {
  const keepTokens = config.context.keepTokens
  const { tail, summarized } = takeTail(history, keepTokens)
  const toSummarize = history.slice(0, summarized)
  if (toSummarize.length === 0) return history

  let instruction = `${COMPACTION_INSTRUCTION}\n\n${serializeHistory(toSummarize)}`
  if (tasks && tasks.length > 0) instruction += formatTasks(tasks)
  const text = await summarize(client, instruction, logger)
  logger.debug('context compacted %d items into summary', toSummarize.length)
  return [{ role: SUMMARY_ROLE, content: text }, ...tail]
}
