import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../src/util/log.ts'
import { cfg, makeSink, messageItem } from '../helpers.ts'

// Records which key/model every model request was actually sent with. Mocks
// only the SDK, so the real createClient/createSession/`sub_agent` tool run.
const requests: { apiKey?: string; model: string }[] = []

vi.mock('openai', () => {
  class FakeOpenAI {
    private readonly apiKey?: string
    constructor(opts: { apiKey?: string }) {
      this.apiKey = opts.apiKey
    }
    responses = {
      stream: (params: { model: string }) => {
        requests.push({ apiKey: this.apiKey, model: params.model })
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'response.output_text.delta', delta: 'ok' }
          },
          finalResponse: async () => ({
            output: [messageItem('ok')],
            output_text: 'ok',
          }),
        }
      },
    }
  }
  return { default: FakeOpenAI }
})

const { createSession, handleLine } = await import('../../src/cli/repl.ts')

// The `sub_agent` tool captures the client it was built with, so it is the place a
// stale client shows up: the REPL's own turns always read session.client.
async function runSubAgent(session: Awaited<ReturnType<typeof createSession>>) {
  const task = session.tools.get('sub_agent')!
  await task.execute(
    { description: 'probe', prompt: 'hi', subagent_type: 'explore' },
    { root: process.cwd(), config: session.config, logger: session.logger },
  )
}

describe('runtime /key and /model changes reach every client user', () => {
  beforeEach(() => {
    requests.length = 0
    vi.stubEnv('XDG_CONFIG_HOME', mkdtempSync(join(tmpdir(), 'dcode-refresh-')))
  })

  it('a sub-agent started after /key set uses the new key', async () => {
    const config = cfg({ apiKey: 'old-key' })
    const s = await createSession(config, createLogger(config))
    await runSubAgent(s)
    expect(requests.at(-1)?.apiKey).toBe('old-key')

    await handleLine(s, '/key set openai new-key', { sink: makeSink().sink })
    await runSubAgent(s)
    expect(requests.at(-1)?.apiKey).toBe('new-key')
  })

  it('the REPL client itself also picks up the new key', async () => {
    const config = cfg({ apiKey: 'old-key' })
    const s = await createSession(config, createLogger(config))
    await handleLine(s, '/key set openai new-key', { sink: makeSink().sink })
    await handleLine(s, 'hello', { sink: makeSink().sink })
    expect(requests.at(-1)?.apiKey).toBe('new-key')
  })

  it('a sub-agent started after /model uses the new model', async () => {
    const config = cfg({ apiKey: 'k' })
    const s = await createSession(config, createLogger(config))
    await handleLine(s, '/model gpt-4o', { sink: makeSink().sink })
    await runSubAgent(s)
    expect(requests.at(-1)?.model).toBe('gpt-4o')
  })
})
