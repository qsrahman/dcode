import { ToolRegistry } from './registry.ts'
import { localTools } from './local/index.ts'
import { webTools } from './local/web.ts'
import type { TaskStore } from '../agent/tasks.ts'
import { todoTool } from './local/task.ts'

// Central registry builder: the single place that assembles all built-in tools
// (local filesystem + web search + task list) into the ToolRegistry. The todo
// tool closes over the per-session TaskStore, so it must be supplied here.
export function createLocalTools(tasks: TaskStore): ToolRegistry {
  return new ToolRegistry([...localTools, ...webTools, todoTool(tasks)])
}
