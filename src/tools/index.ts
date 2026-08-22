import { ToolRegistry } from './registry.ts'
import { localTools } from './local/index.ts'
import { webTools } from './local/web.ts'

// Central registry builder: the single place that assembles all built-in tools
// (local filesystem + web search) into the ToolRegistry.
export function createLocalTools(): ToolRegistry {
  return new ToolRegistry([...localTools, ...webTools])
}
