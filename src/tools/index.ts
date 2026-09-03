import { ToolRegistry } from './registry.ts'
import type { TaskStore } from '../agent/tasks.ts'
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

// Central registry builder: the single place that assembles all built-in tools
// (local filesystem + web search + todo list) into the ToolRegistry. The todo
// tool closes over the per-session TaskStore, so it must be supplied here.
export function createLocalTools(tasks: TaskStore): ToolRegistry {
  return new ToolRegistry([
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
}
