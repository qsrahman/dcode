import { ToolRegistry } from './registry.ts'
import { localTools } from './local.ts'

// Central registry builder: the single place that assembles all local tools
// into the ToolRegistry. MCP tools (P6) will be merged here too.
export function createLocalTools(): ToolRegistry {
  return new ToolRegistry(localTools)
}
