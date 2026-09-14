import { ToolRegistry } from './registry.ts'
import type { TaskStore } from '../agent/todo-store.ts'
import type { Client } from '../agent/client.ts'
import {
  readFileTool,
  listDirTool,
  statTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  copyFileTool,
  deleteFileTool,
  makeDirTool,
} from './local/fs.ts'
import { grepTool, globTool } from './local/search.ts'
import { runShellTool } from './local/exec.ts'
import {
  runProcessTool,
  readProcessTool,
  killProcessTool,
} from './local/process.ts'
import { webSearchTool, webFetchTool } from './local/web.ts'
import { todoTool } from './local/todo.ts'
import { askUserTool } from './local/question.ts'
import { taskTool } from './local/task.ts'
import { unknownAgentTools } from '../agent/subagent.ts'
import type { ToolDefinition } from '../agent/types.ts'

// Central registry builder: the single place that assembles all built-in
// tools (filesystem, search, shell/process, web, todo list, ask_user, and the
// task sub-agent) into the ToolRegistry, plus whatever MCP tools the caller
// already connected (tools/mcp/manager.ts's connectMcpServers — connecting is
// async and per-server fallible, so it happens before this call, not inside
// it; this stays a synchronous, always-succeeds assembly step). `todowrite`
// closes over the per-session TaskStore and `task` over the parent's Client
// and the registry itself (to filter tools for child agents), so all three
// are passed in.
export function createLocalTools(
  tasks: TaskStore,
  client: Client,
  mcpTools: ToolDefinition[] = [],
): ToolRegistry {
  const registry = new ToolRegistry([
    readFileTool(),
    listDirTool(),
    grepTool(),
    statTool(),
    globTool(),
    writeFileTool(),
    editFileTool(),
    moveFileTool(),
    copyFileTool(),
    deleteFileTool(),
    makeDirTool(),
    runShellTool(),
    runProcessTool(),
    readProcessTool(),
    killProcessTool(),
    webSearchTool(),
    webFetchTool(),
    todoTool(tasks),
    askUserTool(),
    ...mcpTools,
  ])
  // The task tool captures the registry by reference, so by the time it's
  // called the registry is fully populated — no chicken-and-egg problem for
  // *execution*. Registered last so its own *description* (generated from
  // the resolved tool sets, see describeAgentTypes) also reflects MCP tools
  // — registering it before they're added would freeze a description that's
  // already stale the moment a server is configured.
  registry.register(taskTool(client, registry))
  // Fail loudly on an agent-type allow-list that names a tool nobody
  // registers: the filter would otherwise just drop it, leaving sub-agents
  // quietly less capable than their own description claims. This can only
  // trip on a bad edit to AGENT_TYPES, so it fires on the first test run
  // rather than in a user's session.
  const missing = unknownAgentTools(registry.list().map((t) => t.name))
  if (missing.length > 0) {
    throw new Error(
      `agent types reference unregistered tools: ${missing.join(', ')}`,
    )
  }
  return registry
}
