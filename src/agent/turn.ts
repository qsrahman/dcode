import type { Client, OpenAIResponse, ResponseInput } from './client.ts'
import type { Config } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'
import type { Tool as ResponsesTool } from 'openai/resources/responses/responses'
import { MarkdownStreamRenderer } from '../ui/markdown.ts'
import type { RunSink } from '../ui/sink.ts'

export interface TurnOpts {
  sink?: RunSink
  logger: Logger
  tools?: ResponsesTool[]
  instructions?: string
  signal?: AbortSignal
  // Called once, immediately before the first visible chunk of this turn's
  // text reaches the sink. The agent loop uses it to freeze the accumulated
  // tool summary above the answer: intermediate reasoning turns emit no
  // visible text, so the first delta reliably marks the tool→answer
  // transition. Not called for a turn that streams nothing (a pure tool call).
  onBeforeText?: () => void
}

// Universal turn runner shared by one-shot and the REPL. Streams output to
// `sink`; the model request is cancellable via `opts.signal`, which is passed
// straight into the SDK's own request-level abort support (decision L).
// Returns the SDK's aggregated Response (its `output_text` is the SDK's own,
// not reconstructed from the deltas). Deltas are rendered as markdown live
// via MarkdownStreamRenderer, which only emits block-complete lines (see
// ui/markdown.ts) so a client never sees broken mid-render markdown (an
// unclosed `**`, a code fence rendered before it closes).
export async function runTurn(
  client: Client,
  config: Config,
  input: ResponseInput,
  opts: TurnOpts,
): Promise<OpenAIResponse> {
  const { logger, tools } = opts
  const sink = opts.sink ?? process.stdout
  logger.debug('run turn model=%s', config.model)
  const stream = client.stream(input, {
    tools,
    instructions: opts.instructions,
    signal: opts.signal,
    reasoningEffort: config.reasoningEffort,
    verbosity: config.verbosity,
  })
  const md = new MarkdownStreamRenderer(config.color)
  let announced = false
  // Fire onBeforeText exactly once, right before the first *visible* write —
  // not on every buffered delta that renders to nothing yet.
  const beforeVisible = () => {
    if (announced) return
    announced = true
    opts.onBeforeText?.()
  }
  const emit = (out: string) => {
    beforeVisible()
    sink.write(out)
  }
  for await (const delta of stream) {
    const out = md.push(delta)
    if (out) emit(out)
  }
  const response = await stream.finalResponse()
  const tail = md.finalize()
  if (tail) emit(tail)
  return response
}
