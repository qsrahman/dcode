import { describe, expect, it, vi, beforeEach } from 'vitest'
import { subAgentTool } from '../../src/tools/local/sub-agent.ts'
import type { ToolContext } from '../../src/agent/types.ts'
import { cfg, fakeClient } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'
import { ToolRegistry } from '../../src/tools/registry.ts'
import { readFileTool } from '../../src/tools/local/fs.ts'

vi.mock('../../src/agent/loop.ts', () => ({
  runAgent: vi.fn(),
}))

import { runAgent } from '../../src/agent/loop.ts'

const mockedRunAgent = vi.mocked(runAgent)

let ctx: ToolContext
let parentTools: ToolRegistry
let client: ReturnType<typeof fakeClient>

beforeEach(() => {
  vi.clearAllMocks()
  client = fakeClient('sub-agent result text')
  mockedRunAgent.mockResolvedValue({
    text: 'sub-agent result text',
    truncated: false,
  })
  parentTools = new ToolRegistry([
    readFileTool(),
    {
      name: 'write_file',
      description: 'write',
      parameters: undefined as never,
      execute: async () => 'ok',
    },
    {
      name: 'grep',
      description: 'search',
      parameters: undefined as never,
      execute: async () => 'ok',
    },
    {
      name: 'sub_agent',
      description: 'spawn',
      parameters: undefined as never,
      execute: async () => 'ok',
    },
  ])
  ctx = {
    root: '/tmp',
    config: cfg(),
    logger: createLogger(cfg()),
  }
})

describe('sub_agent tool', () => {
  it('has correct name', () => {
    expect(subAgentTool(client, parentTools).name).toBe('sub_agent')
  })

  it('runs sub-agent with filtered tools for explore type', async () => {
    const tool = subAgentTool(client, parentTools)
    const result = await tool.execute(
      {
        description: 'find files',
        prompt: 'search for auth middleware',
        subagent_type: 'explore',
      },
      ctx,
    )

    expect(result).toMatch(
      /^<sub_agent state="completed" description="[^"]*" agent="[^"]*">/m,
    )
    expect(result).toContain('sub-agent result text')

    // runAgent called with (client, config, history, opts)
    const opts = mockedRunAgent.mock.calls[0]![3] as {
      tools?: ToolRegistry
    }
    const childNames = opts.tools!.list().map((t) => t.name)
    expect(childNames).toContain('read_file')
    expect(childNames).toContain('grep')
    expect(childNames).not.toContain('write_file')
    expect(childNames).not.toContain('sub_agent')
  })

  it('runs sub-agent with full tools for general type', async () => {
    const tool = subAgentTool(client, parentTools)
    await tool.execute(
      {
        description: 'refactor code',
        prompt: 'refactor the auth module',
        subagent_type: 'general',
      },
      ctx,
    )

    const opts = mockedRunAgent.mock.calls[0]![3] as {
      tools?: ToolRegistry
    }
    const childNames = opts.tools!.list().map((t) => t.name)
    expect(childNames).toContain('read_file')
    expect(childNames).toContain('write_file')
    expect(childNames).toContain('grep')
    expect(childNames).not.toContain('sub_agent')
  })

  // The point of expressing general's tool set as a deny-list rather than a
  // 19-name allow-list: a tool added to the registry reaches the general
  // sub-agent with no second list to remember to update. The old allow-list
  // would silently withhold it.
  it('gives the general agent a newly registered tool automatically', async () => {
    parentTools.register({
      name: 'brand_new_tool',
      description: 'added later',
      parameters: undefined as never,
      execute: async () => 'ok',
    })
    const tool = subAgentTool(client, parentTools)
    await tool.execute(
      { description: 'x', prompt: 'y', subagent_type: 'general' },
      ctx,
    )
    const opts = mockedRunAgent.mock.calls[0]![3] as { tools?: ToolRegistry }
    expect(opts.tools!.list().map((t) => t.name)).toContain('brand_new_tool')
  })

  // ...but explore stays restricted on purpose: read-only is the guarantee,
  // so it must not pick up a new writing tool just because one appeared.
  it('does not give the explore agent a newly registered tool', async () => {
    parentTools.register({
      name: 'brand_new_writer',
      description: 'added later',
      parameters: undefined as never,
      execute: async () => 'ok',
    })
    const tool = subAgentTool(client, parentTools)
    await tool.execute(
      { description: 'x', prompt: 'y', subagent_type: 'explore' },
      ctx,
    )
    const opts = mockedRunAgent.mock.calls[0]![3] as { tools?: ToolRegistry }
    expect(opts.tools!.list().map((t) => t.name)).not.toContain(
      'brand_new_writer',
    )
  })

  it('returns error for unknown agent type', async () => {
    const tool = subAgentTool(client, parentTools)
    const result = await tool.execute(
      {
        description: 'do stuff',
        prompt: 'something',
        subagent_type: 'nonexistent',
      },
      ctx,
    )

    expect(result).toMatch(
      /^<sub_agent state="error" description="[^"]*" agent="[^"]*">/m,
    )
    expect(result).toContain('unknown agent type')
    expect(mockedRunAgent).not.toHaveBeenCalled()
  })

  it('returns error at depth limit', async () => {
    const tool = subAgentTool(client, parentTools)
    const deepCtx: ToolContext = { ...ctx, depth: 1 }
    const result = await tool.execute(
      {
        description: 'nested',
        prompt: 'try to nest',
        subagent_type: 'general',
      },
      deepCtx,
    )

    expect(result).toMatch(
      /^<sub_agent state="error" description="[^"]*" agent="[^"]*">/m,
    )
    expect(result).toContain('nesting limit reached')
    expect(mockedRunAgent).not.toHaveBeenCalled()
  })

  // Sub-agent sessions can't be resumed (unlike the REPL — see sub-agent.ts's
  // module comment), so a sub-agent that hit its own maxToolIterations must
  // tell the parent the result is incomplete rather than returning it as if
  // it were a normal, trustworthy completion.
  it('flags a truncated sub-agent result as incomplete', async () => {
    mockedRunAgent.mockResolvedValue({
      text: 'partial findings',
      truncated: true,
    })
    const tool = subAgentTool(client, parentTools)
    const result = await tool.execute(
      {
        description: 'explore',
        prompt: 'find everything',
        subagent_type: 'explore',
      },
      ctx,
    )

    expect(result).toMatch(
      /^<sub_agent state="completed" description="[^"]*" agent="[^"]*">/m,
    )
    expect(result).toContain('partial findings')
    expect(result).toContain('stopped after')
    expect(result).toContain('treat this result as incomplete')
  })

  // A nested run that behaves the way loop.ts does when its signal fires: keep
  // working until the abort, then throw 'aborted'. Promise<never> because this
  // child never resolves — a sub-agent that blows its budget is cut off
  // mid-flight, not politely finished.
  function mockSubAgentObservingAbort() {
    mockedRunAgent.mockImplementation((_c, _cfg, _h, opts) => {
      return new Promise<never>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        )
      })
    })
  }

  // The defect this closes: runTool's deadline *abandons* a tool promise it loses
  // a race with, and a `general` sub-agent holds write_file/run_shell — so a
  // sub-agent with no budget of its own kept working after the parent stopped
  // waiting, with nobody reading the result. It has to receive the abort itself,
  // not merely lose the race.
  it('stops a sub-agent that outlives subAgentTimeout, naming the budget', async () => {
    mockSubAgentObservingAbort()
    const result = await subAgentTool(client, parentTools).execute(
      {
        description: 'long job',
        prompt: 'take your time',
        subagent_type: 'general',
      },
      { ...ctx, config: cfg({ subAgentTimeout: 20 }) },
    )

    expect(result).toMatch(/^<sub_agent state="error"/m)
    // Named rather than the signal's bare 'aborted', so the parent model can tell
    // a budget worth raising from a cancelled run.
    expect(result).toContain('exceeded its 20ms budget')
    expect(result).toContain('subAgentTimeout')
  })

  // Two very different failures share the signal's bare 'aborted' message, and
  // the parent model can act on only one of them.
  it('ends a sub-agent when the parent is cancelled, without blaming the budget', async () => {
    mockSubAgentObservingAbort()
    const ac = new AbortController()
    const pending = subAgentTool(client, parentTools).execute(
      { description: 'x', prompt: 'y', subagent_type: 'general' },
      { ...ctx, signal: ac.signal },
    )
    ac.abort()
    const result = await pending

    expect(result).toMatch(/^<sub_agent state="error"/m)
    expect(result).toContain('aborted')
    expect(result).not.toContain('budget')
  })

  // Before this, the nested run inherited `ctx.signal` verbatim — undefined for
  // every parent turn that wasn't itself cancelled, so there was nothing to
  // observe and nothing to fire.
  it('gives the nested run its own signal when the parent has none', async () => {
    expect(ctx.signal).toBeUndefined()
    await subAgentTool(client, parentTools).execute(
      { description: 'x', prompt: 'y', subagent_type: 'explore' },
      ctx,
    )

    const opts = mockedRunAgent.mock.calls[0]![3]
    expect(opts?.signal).toBeInstanceOf(AbortSignal)
    expect(opts?.signal?.aborted).toBe(false)
  })

  it('wraps errors from runAgent', async () => {
    mockedRunAgent.mockRejectedValue(new Error('LLM timeout'))
    const tool = subAgentTool(client, parentTools)
    const result = await tool.execute(
      {
        description: 'fail',
        prompt: 'this will fail',
        subagent_type: 'general',
      },
      ctx,
    )

    expect(result).toMatch(
      /^<sub_agent state="error" description="[^"]*" agent="[^"]*">/m,
    )
    expect(result).toContain('LLM timeout')
  })

  it('passes depth+1 to child agent', async () => {
    const tool = subAgentTool(client, parentTools)
    await tool.execute(
      {
        description: 'deep',
        prompt: 'go deep',
        subagent_type: 'general',
      },
      ctx,
    )

    const opts = mockedRunAgent.mock.calls[0]![3] as { depth?: number }
    expect(opts.depth).toBe(1)
  })

  it('passes custom instructions from agent type', async () => {
    const tool = subAgentTool(client, parentTools)
    await tool.execute(
      {
        description: 'explore',
        prompt: 'find auth',
        subagent_type: 'explore',
      },
      ctx,
    )

    const opts = mockedRunAgent.mock.calls[0]![3] as {
      instructions?: string
    }
    expect(opts.instructions).toContain('READ-ONLY')
  })

  it('validates schema rejects invalid input', async () => {
    const { runTool } = await import('../../src/agent/exec.ts')
    const res = await runTool(
      {
        id: 'c',
        name: 'sub_agent',
        arguments: JSON.stringify({ description: 'x' }),
      },
      subAgentTool(client, parentTools),
      ctx,
    )
    expect(res.ok).toBe(false)
  })
})
