import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '../../src/agent/client.ts'
import { cfg } from '../helpers.ts'

// Unlike client.test.ts, this does not mock the SDK: the real OpenAI client
// parses real SSE bytes from a stubbed fetch. What is pinned here is how
// createClient copes with endpoints that stream the Responses protocol loosely
// — the reason it uses `responses.create({ stream: true })` and takes the final
// Response from the server's own terminal event, not the SDK's accumulating
// `responses.stream()` helper.

let seq = 0
const ev = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  sequence_number: seq++,
  ...extra,
})
const resp = (output: unknown[], status = 'completed', extra = {}) => ({
  id: 'resp_1',
  object: 'response',
  created_at: 0,
  model: 'm',
  status,
  output,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  parallel_tool_calls: true,
  tools: [],
  tool_choice: 'auto',
  ...extra,
})
const message = (text: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
})
const functionCall = (args: string) => ({
  id: 'fc_1',
  type: 'function_call',
  call_id: 'call_1',
  name: 'read_file',
  arguments: args,
  status: 'completed',
})
const deltas = (text: string) =>
  text.split('').map((c) =>
    ev('response.output_text.delta', {
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      delta: c,
    }),
  )
// A conformant stream: item added, content part added, deltas, done events.
const conformant = (text: string) => [
  ev('response.created', { response: resp([], 'in_progress') }),
  ev('response.output_item.added', {
    output_index: 0,
    item: { ...message(''), status: 'in_progress', content: [] },
  }),
  ev('response.content_part.added', {
    output_index: 0,
    item_id: 'msg_1',
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  }),
  ...deltas(text),
  ev('response.output_item.done', { output_index: 0, item: message(text) }),
]

function serve(events: unknown[]): void {
  const body = events
    .map(
      (e) =>
        `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`,
    )
    .join('')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
  )
}

async function run(config = cfg({ apiKey: 'k', maxRetries: 0 })) {
  const stream = createClient(config).stream([{ role: 'user', content: 'hi' }])
  let text = ''
  for await (const d of stream) text += d
  return { text, response: await stream.finalResponse() }
}

afterEach(() => vi.unstubAllGlobals())

describe('createClient against real SSE streams', () => {
  it('streams the deltas and returns the response exactly as the server sent it', async () => {
    const final = resp([message('hello')])
    serve([
      ...conformant('hello'),
      ev('response.completed', { response: final }),
    ])
    const { text, response } = await run()
    expect(text).toBe('hello')
    // Exactly what the server sent, plus the SDK's `output_text` convenience
    // (loop.ts reads it; a raw response doesn't carry it).
    expect(response).toEqual({ ...final, output_text: 'hello' })
    // No SDK parsing layer: nothing is added to the content or the items.
    expect(JSON.stringify(response)).not.toContain('parsed')
  })

  it('sets output_text to the concatenated text of every message', async () => {
    const second = { ...message('world'), id: 'msg_2' }
    serve([
      ev('response.completed', { response: resp([message('hello '), second]) }),
    ])
    const { response } = await run()
    expect(response.output_text).toBe('hello world')
  })

  it('leaves a tool call as the server sent it, with no parsed_arguments', async () => {
    const final = resp([functionCall('{"path":"a.ts"}')])
    serve([
      ev('response.created', { response: resp([], 'in_progress') }),
      ev('response.completed', { response: final }),
    ])
    const { response } = await run()
    expect(response.output[0]).toEqual(functionCall('{"path":"a.ts"}'))
    expect('parsed_arguments' in response.output[0]!).toBe(false)
  })

  it('hands malformed tool-call arguments through, for runTool to reject as a tool error', async () => {
    serve([
      ev('response.completed', { response: resp([functionCall('{"path":')]) }),
    ])
    const { response } = await run()
    expect((response.output[0] as { arguments: string }).arguments).toBe(
      '{"path":',
    )
  })

  // The failure the SDK's accumulating helper reported as "missing output at
  // index 0": deltas for an item the endpoint never announced.
  it('tolerates deltas for an item that was never announced', async () => {
    serve([
      ev('response.created', { response: resp([], 'in_progress') }),
      ...deltas('hello'),
      ev('response.completed', { response: resp([message('hello')]) }),
    ])
    const { text, response } = await run()
    expect(text).toBe('hello')
    expect(response.status).toBe('completed')
  })

  it('returns an incomplete response with its reason', async () => {
    const final = resp([message('par')], 'incomplete', {
      incomplete_details: { reason: 'max_output_tokens' },
    })
    serve([
      ...conformant('par'),
      ev('response.incomplete', { response: final }),
    ])
    const { response } = await run()
    expect(response.incomplete_details?.reason).toBe('max_output_tokens')
  })

  it('surfaces a mid-stream error event', async () => {
    serve([
      ...conformant('hel').slice(0, 5),
      ev('error', { code: 'server_error', message: 'boom' }),
    ])
    await expect(run()).rejects.toThrow('boom')
  })

  it('explains a stream that ends without a terminal event', async () => {
    serve(conformant('hello'))
    await expect(
      run(
        cfg({
          apiKey: 'k',
          maxRetries: 0,
          baseURL: 'http://x/v1',
          model: 'gemma',
        }),
      ),
    ).rejects.toThrow(
      /http:\/\/x\/v1.*gemma.*response\.completed.*Try a different model/s,
    )
  })
})
