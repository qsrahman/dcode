import { describe, expect, it } from 'vitest'
import type {
  Client,
  OpenAIResponse,
  ResponseInput,
} from '../../../src/agent/client.ts'
import type { Config } from '../../../src/config/schema.ts'
import { createLogger } from '../../../src/util/log.ts'
import { compactHistory } from '../../../src/agent/context/compact.ts'
import { CONTINUE_PROMPT } from '../../../src/agent/types.ts'
import { cfg } from '../../helpers.ts'

function summaryClient(summary: string): Client {
  return {
    stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield summary
        },
        finalResponse: async () => ({}) as unknown as OpenAIResponse,
      }
    },
  }
}

// Like summaryClient but records the instruction sent to the model, so tests can
// assert on what was included (e.g. the task list).
function capturingClient(summary: string): {
  client: Client
  lastInput: () => ResponseInput
} {
  let last: ResponseInput = []
  const client: Client = {
    stream(input: ResponseInput) {
      last = input
      return {
        async *[Symbol.asyncIterator]() {
          yield summary
        },
        finalResponse: async () => ({}) as unknown as OpenAIResponse,
      }
    },
  }
  return { client, lastInput: () => last }
}

describe('compactHistory', () => {
  it('summarizes the oldest history and keeps a recent tail', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 200000,
        reserved: 20000,
        keepTokens: 1,
        prune: true,
        compactAt: 0.85,
      },
    }) as Config
    const history: ResponseInput = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second request' },
    ]
    const out = await compactHistory(
      summaryClient('SUMMARY'),
      config,
      history,
      createLogger(config),
    )
    // summary message + recent tail (the system prompt lives in `instructions`,
    // not in history)
    expect(out).not.toBeNull()
    expect(out).toHaveLength(2)
    expect((out![0] as { role: string }).role).toBe('user')
    expect((out![0] as { content: string }).content).toBe('SUMMARY')
    // most recent user message retained verbatim
    expect((out![1] as { content: string }).content).toBe('second request')
  })

  // The cut snaps back to a user message so a turn is never split. An injected
  // "Continue." is a user-role item but not a prompt: cutting there would keep
  // the continuation while summarizing away the partial answer it continues.
  it('does not start the tail at an injected Continue.', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 200000,
        reserved: 20000,
        keepTokens: 4, // just enough to reach back to the Continue. item
        prune: true,
        compactAt: 0.85,
      },
    }) as Config
    const history: ResponseInput = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second request' },
      { role: 'assistant', content: 'partial answer' },
      { role: 'user', content: CONTINUE_PROMPT },
      { role: 'assistant', content: 'rest' },
    ]
    const out = await compactHistory(
      summaryClient('SUMMARY'),
      config,
      history,
      createLogger(config),
    )
    const contents = out!.map((h) => (h as { content: string }).content)
    expect(contents).toEqual([
      'SUMMARY',
      'second request',
      'partial answer',
      CONTINUE_PROMPT,
      'rest',
    ])
  })

  it('returns null when there is nothing to summarize', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 200000,
        reserved: 20000,
        keepTokens: 1,
        prune: true,
        compactAt: 0.85,
      },
    }) as Config
    const history: ResponseInput = [{ role: 'user', content: 'only' }]
    const out = await compactHistory(
      summaryClient('SUMMARY'),
      config,
      history,
      createLogger(config),
    )
    expect(out).toBeNull()
  })

  it('appends the authoritative task list to the summary instruction', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 200000,
        reserved: 20000,
        keepTokens: 1,
        prune: true,
        compactAt: 0.85,
      },
    }) as Config
    const history: ResponseInput = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second request' },
    ]
    const { client, lastInput } = capturingClient('SUMMARY')
    const out = await compactHistory(
      client,
      config,
      history,
      createLogger(config),
      [
        { content: 'write tests', status: 'pending', priority: 'high' },
        { content: 'scaffold', status: 'completed', priority: 'medium' },
      ],
    )
    const instruction = (lastInput()[0] as { content: string }).content
    expect(instruction).toContain('Authoritative task list')
    expect(instruction).toContain('[pending] [high] write tests')
    expect(instruction).toContain('[completed] [medium] scaffold')
    // still summarizes the head and keeps the tail verbatim
    expect(out).toHaveLength(2)
  })

  it('omits the task section when no tasks are supplied', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 200000,
        reserved: 20000,
        keepTokens: 1,
        prune: true,
        compactAt: 0.85,
      },
    }) as Config
    const history: ResponseInput = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second request' },
    ]
    const { client, lastInput } = capturingClient('SUMMARY')
    await compactHistory(client, config, history, createLogger(config))
    const instruction = (lastInput()[0] as { content: string }).content
    expect(instruction).not.toContain('Authoritative task list')
  })

  // serializeHistory (used to build the summarization instruction) shares
  // tokens.ts's contentToText extraction, so a message whose content is an
  // array of parts (the shape the Responses API itself uses for assistant
  // output, e.g. [{type: 'output_text', text: '...'}]) is summarized from
  // its actual text — not dumped as a raw JSON blob for the model to parse.
  it('reads array-shaped message content the same way the token estimator does', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 200000,
        reserved: 20000,
        keepTokens: 1,
        prune: true,
        compactAt: 0.85,
      },
    }) as Config
    const history: ResponseInput = [
      { role: 'user', content: 'first request' },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'structured answer' }],
      } as unknown as ResponseInput[number],
      { role: 'user', content: 'second request' },
    ]
    const { client, lastInput } = capturingClient('SUMMARY')
    await compactHistory(client, config, history, createLogger(config))
    const instruction = (lastInput()[0] as { content: string }).content
    expect(instruction).toContain('structured answer')
    expect(instruction).not.toContain('"type"')
  })
})
