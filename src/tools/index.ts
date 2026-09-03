import { ToolRegistry } from './registry.ts'
import type { TaskStore } from '../agent/tasks.ts'
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
import { webTools } from './local/web.ts'
import { todoTool } from './local/todo.ts'
import { askUserTool } from './local/question.ts'
import { taskTool } from './local/task.ts'

// Central registry builder: the single place that assembles all built-in tools
// (local filesystem + web search + todo list) into the ToolRegistry. The todo
// tool closes over the per-session TaskStore, so it must be supplied here.
// The task tool closes over the parent's Client and the registry itself (to
// filter tools for child agents), so both are passed in.
export function createLocalTools(
  tasks: TaskStore,
  client: Client,
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
    ...webTools,
    todoTool(tasks),
    askUserTool(),
  ])
  // The task tool captures the registry by reference, so by the time it's
  // called the registry is fully populated — no chicken-and-egg problem.
  registry.register(taskTool(client, registry))
  return registry
}
