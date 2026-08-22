import type { ToolDefinition } from '../../agent/types.ts'
import {
  readFileTool,
  listDirTool,
  statTool,
  writeFileTool,
  editFileTool,
} from './fs.ts'
import { grepTool, globTool } from './search.ts'
import { runShellTool } from './shell.ts'

// The complete local tool set, assembled from the concern modules in this
// directory. `tools/index.ts` (the hub) is the single place that registers
// these into the central ToolRegistry, so adding a tool is one line here plus
// one import in the hub.
export const localTools: ToolDefinition[] = [
  readFileTool(),
  listDirTool(),
  grepTool(),
  statTool(),
  globTool(),
  writeFileTool(),
  editFileTool(),
  runShellTool(),
]
