import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import type { ToolDefinition } from '../../src/agent/types.ts'
import { createLogger } from '../../src/util/log.ts'
import { cfg } from '../helpers.ts'

const mcpTool: ToolDefinition = {
  name: 'mcp__srv__search',
  description: 'fake mcp tool',
  parameters: z.object({}),
  async execute() {
    return 'ok'
  },
}
const close = vi.fn(async () => {})
const connectMcpServers = vi.fn(async () => ({
  tools: [mcpTool],
  servers: [],
  close,
}))

vi.mock('../../src/tools/mcp/manager.ts', () => ({ connectMcpServers }))

const { createRuntime } = await import('../../src/agent/runtime.ts')

describe('createRuntime', () => {
  it('connects MCP servers from config and registers their tools next to the built-ins', async () => {
    const config = cfg({
      apiKey: 'test-key',
      mcpServers: {
        srv: { type: 'local', enabled: true, command: 'x', args: [] },
      },
    })
    const logger = createLogger(config)
    const rt = await createRuntime(config, logger)
    expect(connectMcpServers).toHaveBeenCalledWith(config.mcpServers, logger)
    const names = rt.tools.list().map((t) => t.name)
    expect(names).toContain('mcp__srv__search')
    expect(names).toContain('read_file')
    expect(rt.mcp.close).toBe(close)
  })

  it('wires todowrite to the returned task store, not a shared default', async () => {
    const config = cfg({ apiKey: 'test-key' })
    const rt = await createRuntime(config, createLogger(config))
    const todo = rt.tools.get('todowrite')!
    await todo.execute(
      { todos: [{ content: 'x', status: 'pending', priority: 'low' }] },
      { root: '/tmp', config, logger: createLogger(config) },
    )
    expect(rt.tasks.list()).toHaveLength(1)
  })
})
