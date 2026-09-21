import type { Config } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'
import { createClient } from './client.ts'
import type { Client } from './client.ts'
import { TaskStore } from './types.ts'
import { connectMcpServers } from '../tools/mcp/manager.ts'
import type { McpManager } from '../tools/mcp/manager.ts'
import { createLocalTools } from '../tools/index.ts'
import type { ToolRegistry } from '../tools/registry.ts'

export interface Runtime {
  client: Client
  tasks: TaskStore
  mcp: McpManager
  tools: ToolRegistry
}

// The session-lived pieces every entry point needs before it can call
// runAgent: one model client, the task list `todowrite` writes to, connected
// MCP servers, and the tool registry built over all three. One-shot mode, the
// REPL, and the stress script all start here so they can't drift apart.
//
// MCP servers are spawned/connected now and stay up until the caller closes
// them (`runtime.mcp.close()`) — decision I in PLAN.md §6. They connect before
// `createLocalTools` because connecting is async and per-server fallible,
// while the registry assembly must stay a synchronous, always-succeeds step.
export async function createRuntime(
  config: Config,
  logger: Logger,
): Promise<Runtime> {
  const client = createClient(config)
  const tasks = new TaskStore()
  const mcp = await connectMcpServers(config.mcpServers, logger)
  return {
    client,
    tasks,
    mcp,
    tools: createLocalTools(tasks, client, mcp.tools),
  }
}
