import { describe, expect, it, vi, beforeEach } from 'vitest'
import { taskTool } from '../../src/tools/local/task.ts'
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
  mockedRunAgent.mockResolvedValue('sub-agent result text')
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
      name: 'task',
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

describe('task tool', () => {
  it('has correct name', () => {
    expect(taskTool(client, parentTools).name).toBe('task')
  })

  it('runs sub-agent with filtered tools for explore type', async () => {
    const tool = taskTool(client, parentTools)
    const result = await tool.execute(
      {
        description: 'find files',
        prompt: 'search for auth middleware',
        subagent_type: 'explore',
      },
      ctx,
    )

    expect(result).toMatch(
      /^<task state="completed" description="[^"]*" agent="[^"]*">/m,
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
    expect(childNames).not.toContain('task')
  })

  it('runs sub-agent with full tools for general type', async () => {
    const tool = taskTool(client, parentTools)
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
    expect(childNames).not.toContain('task')
  })

  it('returns error for unknown agent type', async () => {
    const tool = taskTool(client, parentTools)
    const result = await tool.execute(
      {
        description: 'do stuff',
        prompt: 'something',
        subagent_type: 'nonexistent',
      },
      ctx,
    )

    expect(result).toMatch(
      /^<task state="error" description="[^"]*" agent="[^"]*">/m,
    )
    expect(result).toContain('unknown agent type')
    expect(mockedRunAgent).not.toHaveBeenCalled()
  })

  it('returns error at depth limit', async () => {
    const tool = taskTool(client, parentTools)
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
      /^<task state="error" description="[^"]*" agent="[^"]*">/m,
    )
    expect(result).toContain('nesting limit reached')
    expect(mockedRunAgent).not.toHaveBeenCalled()
  })

  it('wraps errors from runAgent', async () => {
    mockedRunAgent.mockRejectedValue(new Error('LLM timeout'))
    const tool = taskTool(client, parentTools)
    const result = await tool.execute(
      {
        description: 'fail',
        prompt: 'this will fail',
        subagent_type: 'general',
      },
      ctx,
    )

    expect(result).toMatch(
      /^<task state="error" description="[^"]*" agent="[^"]*">/m,
    )
    expect(result).toContain('LLM timeout')
  })

  it('passes depth+1 to child agent', async () => {
    const tool = taskTool(client, parentTools)
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
    const tool = taskTool(client, parentTools)
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
    const { runTool } = await import('../../src/agent/run.ts')
    const res = await runTool(
      {
        id: 'c',
        name: 'task',
        arguments: JSON.stringify({ description: 'x' }),
      },
      taskTool(client, parentTools),
      ctx,
    )
    expect(res.ok).toBe(false)
  })
})
